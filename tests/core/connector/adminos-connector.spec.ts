import { describe, expect, it, vi } from 'vitest';
import { AdminOSConnector } from '../../../src/core/connector/adminos-connector.js';

describe('AdminOSConnector', () => {
  it('注册主机并注册 PersonalHub Agent 服务', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    const connector = new AdminOSConnector({
      serverUrl: 'https://admin.example.test/',
      apiKey: 'test-key',
      hostId: 'host-1',
      fetchImpl,
    });

    await connector.registerHost({
      hostId: 'host-1',
      name: 'Win PC',
      version: '0.1.0',
      mode: 'adminos',
      platform: 'win32',
      startedAt: '2026-07-10T00:00:00.000Z',
      status: 'running',
      pluginCount: 1,
      capabilityCount: 1,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://admin.example.test/api/hosts/register', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ 'x-api-key': 'test-key' }),
    }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({ hostId: 'host-1', name: 'Win PC', os: 'win32' });
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://admin.example.test/api/hosts/host-1/services/register', expect.any(Object));
  });

  it('将租用任务和结果映射到 Hosts API', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { jobId: 'job-1', capability: 'image.describe', input: { imageUrl: 'file://a.png' }, leaseExpiresAt: 1, attemptCount: 1 },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const connector = new AdminOSConnector({
      serverUrl: 'https://admin.example.test',
      apiKey: 'test-key',
      hostId: 'host-1',
      fetchImpl,
    });

    await expect(connector.pullTasks()).resolves.toEqual([
      { remoteTaskId: 'job-1', capability: 'image.describe', input: { imageUrl: 'file://a.png' }, leaseExpiresAt: 1 },
    ]);
    await connector.pushTaskResult({
      remoteTaskId: 'job-1',
      localTaskId: 'local-1',
      status: 'succeeded',
      output: { description: 'ok' },
      error: null,
    });

    expect(fetchImpl).toHaveBeenNthCalledWith(1, 'https://admin.example.test/api/hosts/host-1/jobs/lease', expect.any(Object));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, 'https://admin.example.test/api/hosts/host-1/jobs/job-1/result', expect.any(Object));
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual({ status: 'succeeded', output: { description: 'ok' } });
  });

  it('只接受 AdminOS 同源且大小匹配的更新包', async () => {
    const installer = new TextEncoder().encode('installer').buffer;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        deployment: { deploymentId: 'deployment-1' },
        release: { artifactName: 'PersonalHub-Setup.exe', artifactSha256: 'abc', artifactSizeBytes: installer.byteLength },
        artifactUrl: '/api/hosts/releases/release-1/artifact',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(installer, { status: 200 }));
    const connector = new AdminOSConnector({
      serverUrl: 'https://admin.example.test', apiKey: 'test-key', hostId: 'host-1', fetchImpl,
    });

    const plan = await connector.getUpdatePlan();
    expect(plan).toMatchObject({ deploymentId: 'deployment-1', artifactName: 'PersonalHub-Setup.exe' });
    await expect(connector.downloadUpdate(plan!)).resolves.toEqual(new Uint8Array(installer));
    expect(fetchImpl).toHaveBeenLastCalledWith(
      'https://admin.example.test/api/hosts/releases/release-1/artifact',
      expect.objectContaining({ headers: { 'x-api-key': 'test-key' } }),
    );
  });
});
