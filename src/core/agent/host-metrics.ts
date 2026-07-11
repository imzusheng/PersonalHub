import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { HostMetrics } from '../connector/connector.js';

const execFileAsync = promisify(execFile);
const GPU_QUERY_TIMEOUT_MS = 3_000;
const GPU_CACHE_MS = 30_000;

let cachedGpu: Partial<HostMetrics> = {};
let gpuCheckedAt = 0;

/** 上一轮网络采样（用于计算每秒速率） */
let lastNetSample: { at: number; rx: number; tx: number } | null = null;

/** 上一轮 CPU 采样（用于计算实际使用率） */
let lastCpuSample: { at: number; idle: number; total: number } | null = null;

async function getGpuMetrics(): Promise<Partial<HostMetrics>> {
  const now = Date.now();
  if (now - gpuCheckedAt < GPU_CACHE_MS) return cachedGpu;
  gpuCheckedAt = now;
  try {
    const { stdout } = await execFileAsync('nvidia-smi', [
      '--query-gpu=name,memory.total,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: GPU_QUERY_TIMEOUT_MS, windowsHide: true });
    const [name, vram, utilization, temperature] = stdout.trim().split('\n')[0]?.split(',').map((value) => value.trim()) ?? [];
    const gpuVramMB = Number(vram);
    const gpuUtilPercent = Number(utilization);
    const gpuTempC = Number(temperature);
    cachedGpu = {
      ...(name ? { gpuName: name } : {}),
      ...(Number.isFinite(gpuVramMB) ? { gpuVramMB } : {}),
      ...(Number.isFinite(gpuUtilPercent) ? { gpuUtilPercent } : {}),
      ...(Number.isFinite(gpuTempC) ? { gpuTempC } : {}),
    };
  } catch {
    cachedGpu = {};
  }
  return cachedGpu;
}

function getCpuPercent(): number | undefined {
  const cpus = os.cpus();
  if (cpus.length === 0) return undefined;

  // 计算每核的 (idle, total) 差值
  let totalDelta = 0;
  let idleDelta = 0;
  const now = Date.now();

  for (const cpu of cpus) {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    const idle = cpu.times.idle;
    totalDelta += total;
    idleDelta += idle;
  }

  if (lastCpuSample) {
    const elapsed = now - lastCpuSample.at;
    if (elapsed > 0) {
      const totalDiff = totalDelta - lastCpuSample.total;
      const idleDiff = idleDelta - lastCpuSample.idle;
      const usagePercent = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
      lastCpuSample = { at: now, idle: idleDelta, total: totalDelta };
      return Math.min(Math.round(usagePercent), 100);
    }
  }

  lastCpuSample = { at: now, idle: idleDelta, total: totalDelta };
  return undefined; // 第一轮无法计算差值
}

function getNetBytesPerSec(): { netRxBytesPerSec: number; netTxBytesPerSec: number } | undefined {
  const interfaces = os.networkInterfaces();
  let totalRx = 0;
  let totalTx = 0;

  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      // 跳过内部/回环接口的数据
      if (addr.internal) continue;
      // bytesRecv/bytesSent 在运行时存在，但不在 Node.js 类型定义中
      const raw = addr as { bytesRecv?: number; bytesSent?: number };
      totalRx += raw.bytesRecv ?? 0;
      totalTx += raw.bytesSent ?? 0;
    }
  }

  const now = Date.now();
  if (lastNetSample) {
    const elapsed = Math.max((now - lastNetSample.at) / 1000, 0.001);
    const rxPerSec = Math.max(0, Math.round((totalRx - lastNetSample.rx) / elapsed));
    const txPerSec = Math.max(0, Math.round((totalTx - lastNetSample.tx) / elapsed));
    lastNetSample = { at: now, rx: totalRx, tx: totalTx };
    return { netRxBytesPerSec: rxPerSec, netTxBytesPerSec: txPerSec };
  }

  lastNetSample = { at: now, rx: totalRx, tx: totalTx };
  return undefined; // 第一轮没有差值
}

function getDiskPercent(): number | undefined {
  try {
    // 只在 Linux/macOS 上有 statvfs 风格的 API；Windows 用别的方式
    // Node.js 没有内置磁盘使用率 API，返回 undefined
    // Windows 上可通过 wmic 获取，但开销太大，先跳过
    return undefined;
  } catch {
    return undefined;
  }
}

export async function collectHostMetrics(): Promise<HostMetrics> {
  const totalMemory = os.totalmem();
  const memoryPercent = totalMemory > 0 ? Math.round(((totalMemory - os.freemem()) / totalMemory) * 100) : 0;

  const cpuPercent = getCpuPercent();
  const net = getNetBytesPerSec();
  const disk = getDiskPercent();
  const gpu = await getGpuMetrics();

  return {
    memoryPercent,
    ...(cpuPercent !== undefined ? { cpuPercent } : {}),
    ...(net ?? {}),
    ...(disk !== undefined ? { diskUsedPercent: disk } : {}),
    ...gpu,
    recordedAt: Date.now(),
  };
}
