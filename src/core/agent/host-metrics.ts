import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type { HostMetrics } from '../connector/connector.js';

const execFileAsync = promisify(execFile);
const GPU_QUERY_TIMEOUT_MS = 3_000;
const GPU_CACHE_MS = 30_000;

let cachedGpu: Partial<HostMetrics> = {};
let gpuCheckedAt = 0;

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

export async function collectHostMetrics(): Promise<HostMetrics> {
  const totalMemory = os.totalmem();
  const memoryPercent = totalMemory > 0 ? Math.round(((totalMemory - os.freemem()) / totalMemory) * 100) : 0;
  const cpuCount = os.cpus().length;
  const load = os.loadavg()[0];
  const cpuPercent = process.platform === 'win32' || cpuCount === 0 ? undefined : Math.min(Math.round((load / cpuCount) * 100), 100);
  return {
    memoryPercent,
    ...(cpuPercent === undefined ? {} : { cpuPercent }),
    ...(await getGpuMetrics()),
    recordedAt: Date.now(),
  };
}
