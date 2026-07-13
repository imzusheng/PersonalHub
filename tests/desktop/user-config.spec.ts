import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadUserConfig, updateUserConfig } from '../../src/desktop/main/user-config.js';

describe('user config diagnostics retention', () => {
  let directory = '';

  afterEach(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('defaults to seven days and persists a valid update', () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personalhub-config-'));
    const initial = loadUserConfig(directory);
    expect(initial.logRetentionDays).toBe(7);
    const updated = updateUserConfig(directory, initial, { logRetentionDays: 30 });
    expect(updated.logRetentionDays).toBe(30);
    expect(loadUserConfig(directory).logRetentionDays).toBe(30);
  });
});
