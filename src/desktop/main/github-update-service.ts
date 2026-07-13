import fs from 'node:fs';
import path from 'node:path';
import type { AppUpdater, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater';

export type UpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  currentVersion: string;
  availableVersion: string | null;
  releaseName: string | null;
  releaseNotes: string | null;
  releaseDate: string | null;
  progressPercent: number | null;
  bytesPerSecond: number | null;
  transferredBytes: number | null;
  totalBytes: number | null;
  checkedAt: string | null;
  error: string | null;
}

interface PersistedUpdateState {
  lastAutomaticCheckAt?: string;
}

export interface GithubUpdateServiceOptions {
  updater: AppUpdater;
  currentVersion: string;
  isPackaged: boolean;
  persistenceFile: string;
  onStateChange?: (state: UpdateState) => void;
  logger?: (message: string) => void;
  now?: () => number;
  automaticCheckIntervalMs?: number;
  automaticDownload?: boolean;
}

const DEFAULT_AUTOMATIC_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.slice(0, 8_000);
  if (!Array.isArray(notes)) return null;
  return notes
    .map((entry) => `${entry.version ? `${entry.version}\n` : ''}${entry.note ?? ''}`.trim())
    .filter(Boolean)
    .join('\n\n')
    .slice(0, 8_000) || null;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/([?&](?:token|access_token|key)=)[^&\s]+/gi, '$1[redacted]').slice(0, 1_000);
}

export class GithubUpdateService {
  private readonly updater: AppUpdater;
  private readonly currentVersion: string;
  private readonly isPackaged: boolean;
  private readonly persistenceFile: string;
  private readonly onStateChange?: (state: UpdateState) => void;
  private readonly logger: (message: string) => void;
  private readonly now: () => number;
  private readonly automaticCheckIntervalMs: number;
  private readonly automaticDownload: boolean;
  private automaticTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private downloadPromise: Promise<UpdateState> | null = null;
  private state: UpdateState;

  constructor(options: GithubUpdateServiceOptions) {
    this.updater = options.updater;
    this.currentVersion = options.currentVersion;
    this.isPackaged = options.isPackaged;
    this.persistenceFile = options.persistenceFile;
    this.onStateChange = options.onStateChange;
    this.logger = options.logger ?? (() => undefined);
    this.now = options.now ?? Date.now;
    this.automaticCheckIntervalMs = options.automaticCheckIntervalMs ?? DEFAULT_AUTOMATIC_CHECK_INTERVAL_MS;
    this.automaticDownload = options.automaticDownload ?? true;
    this.state = {
      phase: this.isPackaged ? 'idle' : 'disabled',
      currentVersion: this.currentVersion,
      availableVersion: null,
      releaseName: null,
      releaseNotes: null,
      releaseDate: null,
      progressPercent: null,
      bytesPerSecond: null,
      transferredBytes: null,
      totalBytes: null,
      checkedAt: null,
      error: this.isPackaged ? null : '开发模式不执行自动更新',
    };

    this.updater.autoDownload = false;
    this.updater.autoInstallOnAppQuit = false;
    this.updater.autoRunAppAfterInstall = true;
    this.updater.allowPrerelease = false;
    this.updater.fullChangelog = false;
    this.bindUpdaterEvents();
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  startAutomaticChecks(initialDelayMs = 20_000, pollIntervalMs = 6 * 60 * 60 * 1_000): void {
    if (!this.isPackaged || this.automaticTimer || this.intervalTimer) return;
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = null;
      void this.checkForUpdates(false);
    }, initialDelayMs);
    this.automaticTimer.unref?.();
    this.intervalTimer = setInterval(() => { void this.checkForUpdates(false); }, pollIntervalMs);
    this.intervalTimer.unref?.();
  }

  stopAutomaticChecks(): void {
    if (this.automaticTimer) clearTimeout(this.automaticTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.automaticTimer = null;
    this.intervalTimer = null;
  }

  async checkForUpdates(manual = true): Promise<UpdateState> {
    if (!this.isPackaged) return this.getState();
    if (['checking', 'downloading', 'installing'].includes(this.state.phase)) return this.getState();
    if (!manual && !this.isAutomaticCheckDue()) return this.getState();

    const checkedAt = new Date(this.now()).toISOString();
    if (!manual) this.persistAutomaticCheck(checkedAt);
    this.setState({ phase: 'checking', checkedAt, error: null });
    this.logger(`update: checking GitHub Release (${manual ? 'manual' : 'automatic'})`);
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.handleError(error);
    }
    return this.getState();
  }

  async downloadUpdate(): Promise<UpdateState> {
    if (!this.isPackaged) return this.getState();
    if (this.downloadPromise) return this.downloadPromise;
    if (this.state.phase !== 'available' && this.state.phase !== 'error') return this.getState();

    this.setState({
      phase: 'downloading',
      progressPercent: 0,
      bytesPerSecond: null,
      transferredBytes: 0,
      totalBytes: null,
      error: null,
    });
    this.downloadPromise = this.updater.downloadUpdate()
      .then(() => this.getState())
      .catch((error) => {
        this.handleError(error);
        return this.getState();
      })
      .finally(() => { this.downloadPromise = null; });
    return this.downloadPromise;
  }

  installUpdate(): UpdateState {
    if (this.state.phase !== 'downloaded') throw new Error('更新尚未下载完成');
    this.stopAutomaticChecks();
    this.setState({ phase: 'installing', error: null });
    this.updater.quitAndInstall(false, true);
    return this.getState();
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      this.setState({ phase: 'checking', error: null });
    });
    this.updater.on('update-not-available', (info) => {
      this.logger(`update: current version ${this.currentVersion} is up to date (${info.version})`);
      this.setState({
        phase: 'up-to-date',
        availableVersion: null,
        releaseName: null,
        releaseNotes: null,
        releaseDate: info.releaseDate ?? null,
        progressPercent: null,
        bytesPerSecond: null,
        transferredBytes: null,
        totalBytes: null,
        error: null,
      });
    });
    this.updater.on('update-available', (info) => {
      this.logger(`update: version ${info.version} is available`);
      this.setState({
        phase: 'available',
        availableVersion: info.version,
        releaseName: info.releaseName ?? null,
        releaseNotes: releaseNotesText(info.releaseNotes),
        releaseDate: info.releaseDate ?? null,
        progressPercent: null,
        bytesPerSecond: null,
        transferredBytes: null,
        totalBytes: null,
        error: null,
      });
      if (this.automaticDownload) void this.downloadUpdate();
    });
    this.updater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        phase: 'downloading',
        progressPercent: Math.max(0, Math.min(100, progress.percent)),
        bytesPerSecond: progress.bytesPerSecond,
        transferredBytes: progress.transferred,
        totalBytes: progress.total,
        error: null,
      });
    });
    this.updater.on('update-downloaded', (event: UpdateDownloadedEvent) => {
      this.logger(`update: version ${event.version} downloaded`);
      this.setState({
        phase: 'downloaded',
        availableVersion: event.version,
        releaseName: event.releaseName ?? this.state.releaseName,
        releaseNotes: releaseNotesText(event.releaseNotes) ?? this.state.releaseNotes,
        releaseDate: event.releaseDate ?? this.state.releaseDate,
        progressPercent: 100,
        transferredBytes: this.state.totalBytes ?? this.state.transferredBytes,
        error: null,
      });
    });
    this.updater.on('error', (error) => this.handleError(error));
  }

  private setState(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.(this.getState());
  }

  private handleError(error: unknown): void {
    const message = errorMessage(error);
    this.logger(`update: error - ${message}`);
    this.setState({ phase: 'error', error: message });
  }

  private isAutomaticCheckDue(): boolean {
    try {
      const persisted = JSON.parse(fs.readFileSync(this.persistenceFile, 'utf-8')) as PersistedUpdateState;
      const last = persisted.lastAutomaticCheckAt ? Date.parse(persisted.lastAutomaticCheckAt) : Number.NaN;
      return !Number.isFinite(last) || this.now() - last >= this.automaticCheckIntervalMs;
    } catch {
      return true;
    }
  }

  private persistAutomaticCheck(checkedAt: string): void {
    try {
      fs.mkdirSync(path.dirname(this.persistenceFile), { recursive: true });
      const temporary = `${this.persistenceFile}.tmp`;
      fs.writeFileSync(temporary, `${JSON.stringify({ lastAutomaticCheckAt: checkedAt }, null, 2)}\n`, 'utf-8');
      fs.renameSync(temporary, this.persistenceFile);
    } catch (error) {
      this.logger(`update: failed to persist check time - ${errorMessage(error)}`);
    }
  }
}
