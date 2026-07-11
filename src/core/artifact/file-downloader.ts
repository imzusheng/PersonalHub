import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface DownloadResult {
  localPath: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  sha256: string;
}

export interface DownloadOptions {
  /** 下载超时 ms，默认 300_000 (5 min) */
  timeoutMs?: number;
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
  /** 预期的 SHA-256（可选，如果提供则校验） */
  expectedSha256?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;

export async function downloadFile(
  url: string,
  destDir: string,
  fileName?: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await attemptDownload(url, destDir, timeoutMs, opts.expectedSha256, fileName);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        // 指数退避
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error('下载失败');
}

async function attemptDownload(
  url: string,
  destDir: string,
  timeoutMs: number,
  expectedSha256?: string,
  fileName?: string,
): Promise<DownloadResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`下载失败: HTTP ${response.status}`);
    }

    const contentDisposition = response.headers.get('content-disposition');
    const resolvedName = fileName ?? extractFileName(url, contentDisposition);
    const mimeType = response.headers.get('content-type');
    const buffer = Buffer.from(await response.arrayBuffer());

    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    if (expectedSha256 && sha256 !== expectedSha256) {
      throw new Error(
        `SHA-256 校验失败: 期望 ${expectedSha256.slice(0, 12)}.., 实际 ${sha256.slice(0, 12)}..`,
      );
    }

    fs.mkdirSync(destDir, { recursive: true });
    const localPath = path.join(destDir, resolvedName);
    fs.writeFileSync(localPath, buffer);

    return {
      localPath,
      fileName: resolvedName,
      mimeType,
      sizeBytes: buffer.byteLength,
      sha256,
    };
  } finally {
    clearTimeout(timer);
  }
}

function extractFileName(url: string, contentDisposition: string | null): string {
  // 尝试从 Content-Disposition 解析
  if (contentDisposition) {
    const match = contentDisposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';]+)["']?/i);
    if (match) return decodeURIComponent(match[1]);
  }
  // 从 URL 路径提取
  try {
    const urlPath = new URL(url).pathname;
    const name = urlPath.split('/').pop();
    if (name) return decodeURIComponent(name);
  } catch {
    // URL 解析失败
  }
  // 回退：用 URL hash 生成名字
  const hash = crypto.createHash('md5').update(url).digest('hex').slice(0, 8);
  return `download-${hash}`;
}
