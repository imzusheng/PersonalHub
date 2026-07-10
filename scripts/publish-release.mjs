import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

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

const form = new FormData();
form.set('metadata', JSON.stringify(metadata));
form.set('file', new Blob([artifact], { type: metadata.artifactMimeType }), artifactName);
const response = await fetch(`${webhookUrl.replace(/\/$/, '')}/upload`, {
  method: 'POST',
  headers: { 'x-ci-hook-token': webhookToken },
  body: form,
});
if (!response.ok) throw new Error(`AdminOS 发布失败: HTTP ${response.status}`);
