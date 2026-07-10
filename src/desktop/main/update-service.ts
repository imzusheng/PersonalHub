import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AdminOSConnector, AdminOSUpdatePlan } from '../../core/connector/adminos-connector.js';

function sanitizeFilename(filename: string): string {
  const sanitized = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!sanitized.toLowerCase().endsWith('.exe')) throw new Error('PersonalHub 更新包必须是 .exe 文件');
  return sanitized;
}

export class UpdateService {
  constructor(private readonly connector: AdminOSConnector, private readonly downloadDirectory: string) {}

  async check(): Promise<AdminOSUpdatePlan | null> {
    return this.connector.getUpdatePlan();
  }

  async download(plan: AdminOSUpdatePlan): Promise<string> {
    await this.connector.claimUpdate(plan.deploymentId);
    await this.connector.recordUpdateEvent(plan.deploymentId, 'download', '开始下载 PersonalHub 更新包');
    const bytes = await this.connector.downloadUpdate(plan);
    const checksum = createHash('sha256').update(bytes).digest('hex');
    if (checksum !== plan.artifactSha256) throw new Error('更新包 SHA256 校验失败');
    fs.mkdirSync(this.downloadDirectory, { recursive: true });
    const targetPath = path.join(this.downloadDirectory, sanitizeFilename(plan.artifactName));
    const temporaryPath = `${targetPath}.tmp`;
    fs.writeFileSync(temporaryPath, bytes);
    fs.renameSync(temporaryPath, targetPath);
    await this.connector.recordUpdateEvent(plan.deploymentId, 'downloaded', 'PersonalHub 更新包下载并校验完成');
    return targetPath;
  }
}
