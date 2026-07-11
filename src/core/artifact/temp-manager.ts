import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const JOB_DIR_PREFIX = 'personalhub-job-';
const FAILURE_KEEP_MS = 3_600_000; // 失败任务保留 1 小时

export interface WorkDir {
  jobDir: string;
  inputDir: string;
  outputDir: string;
}

let _baseDir: string | null = null;

function getBaseDir(): string {
  if (!_baseDir) {
    _baseDir = path.join(os.tmpdir(), 'personalhub-jobs');
  }
  fs.mkdirSync(_baseDir, { recursive: true });
  return _baseDir;
}

export function setBaseDir(dir: string): void {
  _baseDir = dir;
}

export function createWorkDir(jobId: string): WorkDir {
  const baseDir = getBaseDir();
  const sanitized = String(jobId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const jobDir = path.join(baseDir, `${JOB_DIR_PREFIX}${sanitized}`);
  const inputDir = path.join(jobDir, 'input');
  const outputDir = path.join(jobDir, 'output');

  fs.mkdirSync(inputDir, { recursive: true });
  fs.mkdirSync(outputDir, { recursive: true });

  return { jobDir, inputDir, outputDir };
}

export function cleanup(workDir: WorkDir, keepOnFailure: boolean): void {
  const { jobDir } = workDir;
  if (!fs.existsSync(jobDir)) return;

  if (keepOnFailure) {
    // 失败时保留 1 小时便于排查，然后延迟删除
    setTimeout(() => {
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch { /* 静默 */ }
    }, FAILURE_KEEP_MS);
  } else {
    fs.rmSync(jobDir, { recursive: true, force: true });
  }
}

/** 定期清理超过 24 小时的残留目录 */
export function cleanupStaleDirs(): void {
  const baseDir = getBaseDir();
  if (!fs.existsSync(baseDir)) return;
  const now = Date.now();
  const entries = fs.readdirSync(baseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(JOB_DIR_PREFIX)) continue;
    const fullPath = path.join(baseDir, entry.name);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > 86_400_000) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      }
    } catch {
      // 目录可能已被删除
    }
  }
}
