import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface FileToUpload {
  localPath: string;
  name: string;
  mimeType?: string;
}

export interface UploadOptions {
  /** 上传超时 ms，默认 120_000 */
  timeoutMs?: number;
  /** 最大重试次数，默认 3 */
  maxRetries?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 3_000;

/**
 * 构建 multipart/form-data 边界并上传多个文件到指定 URL。
 * 与旧 ASR agent 的 succeeded 端点协议兼容。
 */
export async function uploadFiles(
  uploadUrl: string,
  apiKey: string,
  files: FileToUpload[],
  opts: UploadOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await attemptUpload(uploadUrl, apiKey, files, timeoutMs);
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt + Math.random() * 1000;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastError ?? new Error('文件上传失败');
}

async function attemptUpload(
  uploadUrl: string,
  apiKey: string,
  files: FileToUpload[],
  timeoutMs: number,
): Promise<void> {
  const boundary = `----PersonalHub${crypto.randomBytes(16).toString('hex')}`;
  const parts: Buffer[] = [];

  for (const file of files) {
    if (!fs.existsSync(file.localPath)) {
      throw new Error(`文件不存在: ${file.localPath}`);
    }
    const content = fs.readFileSync(file.localPath);
    const fileName = file.name || path.basename(file.localPath);
    const mimeType = file.mimeType || guessMimeType(fileName);

    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${fileName}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    ));
    parts.push(content);
    parts.push(Buffer.from('\r\n'));
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const body = Buffer.concat(parts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`上传失败: HTTP ${response.status}${text ? ` - ${text.slice(0, 200)}` : ''}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.json': 'application/json',
    '.srt': 'text/plain',
    '.vtt': 'text/vtt',
    '.csv': 'text/csv',
    '.xml': 'application/xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
  };
  return map[ext] ?? 'application/octet-stream';
}
