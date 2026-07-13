import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdater } from 'electron-updater';
import { GithubUpdateService, type UpdateState } from '../../src/desktop/main/github-update-service.js';

class FakeUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = false;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  fullChangelog = true;
  checkForUpdates = vi.fn(async () => null);
  downloadUpdate = vi.fn(async () => [] as string[]);
  quitAndInstall = vi.fn();
}

const temporaryDirectories: string[] = [];
function persistenceFile(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personalhub-update-'));
  temporaryDirectories.push(directory);
  return path.join(directory, 'state.json');
}
function asUpdater(updater: FakeUpdater): AppUpdater { return updater as unknown as AppUpdater; }

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('GithubUpdateService', () => {
  it('开发模式禁用 GitHub 检查', async () => {
    const updater = new FakeUpdater();
    const service = new GithubUpdateService({ updater: asUpdater(updater), currentVersion: '0.1.0', isPackaged: false, persistenceFile: persistenceFile() });

    await expect(service.checkForUpdates()).resolves.toMatchObject({ phase: 'disabled', currentVersion: '0.1.0' });
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('公开下载进度，并在下载完成后允许重启安装', async () => {
    const updater = new FakeUpdater();
    const states: UpdateState[] = [];
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-available', { version: '0.2.0', releaseName: 'PersonalHub 0.2.0', releaseNotes: '更新说明', releaseDate: '2026-07-13T00:00:00.000Z' });
      return null;
    });
    updater.downloadUpdate.mockImplementation(async () => {
      updater.emit('download-progress', { percent: 42.5, bytesPerSecond: 2048, transferred: 4_250, total: 10_000 });
      updater.emit('update-downloaded', { version: '0.2.0', releaseName: 'PersonalHub 0.2.0', releaseNotes: '更新说明', releaseDate: '2026-07-13T00:00:00.000Z' });
      return [];
    });
    const service = new GithubUpdateService({ updater: asUpdater(updater), currentVersion: '0.1.0', isPackaged: true, persistenceFile: persistenceFile(), automaticDownload: false, onStateChange: (state) => states.push(state) });

    await service.checkForUpdates();
    expect(service.getState()).toMatchObject({ phase: 'available', availableVersion: '0.2.0' });
    await service.downloadUpdate();
    expect(states).toContainEqual(expect.objectContaining({ phase: 'downloading', progressPercent: 42.5, transferredBytes: 4_250 }));
    expect(service.getState()).toMatchObject({ phase: 'downloaded', progressPercent: 100 });

    service.installUpdate();
    expect(service.getState().phase).toBe('installing');
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('自动检查按持久化的六小时间隔节流', async () => {
    const updater = new FakeUpdater();
    let now = Date.parse('2026-07-13T00:00:00.000Z');
    updater.checkForUpdates.mockImplementation(async () => {
      updater.emit('update-not-available', { version: '0.1.0', releaseDate: '2026-07-13T00:00:00.000Z' });
      return null;
    });
    const service = new GithubUpdateService({ updater: asUpdater(updater), currentVersion: '0.1.0', isPackaged: true, persistenceFile: persistenceFile(), now: () => now });

    await service.checkForUpdates(false);
    await service.checkForUpdates(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    now += 6 * 60 * 60 * 1_000;
    await service.checkForUpdates(false);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
