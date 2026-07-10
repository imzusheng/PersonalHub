import { spawn } from 'node:child_process';

const MAX_OUTPUT_BYTES = 1_000_000;

export async function runJsonProcess(command: string, args: string[], input: unknown, timeoutMs: number, cwd?: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error(`运行超时: ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error('运行输出超过限制'));
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      if (code !== 0) return finish(new Error(stderr.trim() || `运行进程退出: ${code}`));
      try {
        finish(undefined, JSON.parse(stdout));
      } catch {
        finish(new Error('运行输出不是有效 JSON'));
      }
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}
