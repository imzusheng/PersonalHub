import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const webhookUrl = process.env.ADMINOS_RELEASE_WEBHOOK_URL;
const webhookToken = process.env.ADMINOS_RELEASE_WEBHOOK_TOKEN;
const artifactPath = process.env.PERSONALHUB_ARTIFACT_PATH;

if (!webhookUrl || !webhookToken || !artifactPath) {
  throw new Error('ADMINOS_RELEASE_WEBHOOK_URL、ADMINOS_RELEASE_WEBHOOK_TOKEN、PERSONALHUB_ARTIFACT_PATH 均为必填');
}

const artifact = await readFile(artifactPath);
const artifactName = path.basename(artifactPath);
const sha = process.env.GITHUB_SHA || createHash('sha256').update(artifact).digest('hex');
const metadata = {
  repository: process.env.GITHUB_REPOSITORY || null,
  branch: process.env.GITHUB_REF_NAME || null,
  sha,
  runId: process.env.GITHUB_RUN_ID || null,
  runNumber: process.env.GITHUB_RUN_NUMBER ? Number(process.env.GITHUB_RUN_NUMBER) : null,
  channel: process.env.PERSONALHUB_RELEASE_CHANNEL || 'stable',
  artifactName,
  artifactSha256: createHash('sha256').update(artifact).digest('hex'),
  artifactSizeBytes: artifact.length,
  artifactMimeType: 'application/vnd.microsoft.portable-executable',
  targetServiceKind: 'personalhub-agent',
  manifest: { version: process.env.PERSONALHUB_VERSION || null, platform: 'win32', arch: 'x64' },
};

await execFileAsync('curl.exe', [
  '--fail', '--silent', '--show-error', '--max-time', '1800',
  '-H', `x-ci-hook-token: ${webhookToken}`,
  '-F', `metadata=${JSON.stringify(metadata)}`,
  '-F', `file=@${artifactPath};type=${metadata.artifactMimeType}`,
  `${webhookUrl.replace(/\/$/, '')}/upload`,
], { windowsHide: true, maxBuffer: 1024 * 1024 });
