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

async function getMemoryPercent(): Promise<number> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('vm_stat', [], { timeout: 2_000 });
      const pageSize = Number(stdout.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
      const pages = new Map<string, number>();
      for (const line of stdout.split('\n')) {
        const match = line.match(/^([^:]+):\s+(\d+)/);
        if (match) pages.set(match[1], Number(match[2]));
      }
      const availablePages = (pages.get('Pages free') ?? 0) + (pages.get('Pages inactive') ?? 0) + (pages.get('Pages speculative') ?? 0);
      const availableBytes = availablePages * pageSize;
      return Math.min(100, Math.max(0, Math.round(((os.totalmem() - availableBytes) / os.totalmem()) * 100)));
    } catch { /* fall through to the portable approximation */ }
  }
  const totalMemory = os.totalmem();
  return totalMemory > 0 ? Math.round(((totalMemory - os.freemem()) / totalMemory) * 100) : 0;
}

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

async function getNetTotals(): Promise<{ rx: number; tx: number } | undefined> {
  try {
    if (process.platform === 'linux') {
      const { stdout } = await execFileAsync('cat', ['/proc/net/dev'], { timeout: 2_000 });
      let rx = 0; let tx = 0;
      for (const line of stdout.split('\n').slice(2)) {
        const [name, values] = line.split(':');
        if (!values || name.trim() === 'lo') continue;
        const fields = values.trim().split(/\s+/).map(Number);
        rx += fields[0] || 0; tx += fields[8] || 0;
      }
      return { rx, tx };
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('netstat', ['-ibn'], { timeout: 2_000 });
      const totals = new Map<string, { rx: number; tx: number }>();
      for (const line of stdout.split('\n').slice(1)) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10 || fields[0] === 'lo0' || !fields[0]) continue;
        const input = Number(fields[6]); const output = Number(fields[9]);
        const previous = totals.get(fields[0]) ?? { rx: 0, tx: 0 };
        totals.set(fields[0], {
          rx: Number.isFinite(input) ? Math.max(previous.rx, input) : previous.rx,
          tx: Number.isFinite(output) ? Math.max(previous.tx, output) : previous.tx,
        });
      }
      let rx = 0; let tx = 0;
      for (const value of totals.values()) { rx += value.rx; tx += value.tx; }
      return { rx, tx };
    }
    if (process.platform === 'win32') {
      const script = '(Get-NetAdapterStatistics | Measure-Object -Property ReceivedBytes -Sum).Sum; (Get-NetAdapterStatistics | Measure-Object -Property SentBytes -Sum).Sum';
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3_000, windowsHide: true });
      const [rx, tx] = stdout.trim().split(/\r?\n/).map(Number);
      if (Number.isFinite(rx) && Number.isFinite(tx)) return { rx, tx };
    }
  } catch { /* metric remains unavailable */ }
  return undefined;
}

async function getNetBytesPerSec(): Promise<{ netRxBytesPerSec: number; netTxBytesPerSec: number } | undefined> {
  const totals = await getNetTotals();
  if (!totals) return undefined;
  const { rx: totalRx, tx: totalTx } = totals;

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
  const memoryPercent = await getMemoryPercent();

  const cpuPercent = getCpuPercent();
  const net = await getNetBytesPerSec();
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
