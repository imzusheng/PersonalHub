import { describe, expect, it, vi } from 'vitest';
import { AdminOSConnector } from '../../../src/core/connector/adminos-connector.js';

describe('AdminOSConnector', () => {
  it('只注册主机，不把 PersonalHub Agent 注册为业务服务', async () => {
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
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('同步真实插件快照并在停止时保留插件、立即断开主机', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
    const connector = new AdminOSConnector({ serverUrl: 'https://admin.example.test', apiKey: 'test-key', hostId: 'host-1', fetchImpl });
    const services = [{ serviceId: 'ollama.embed:host-1', kind: 'ollama.embed', name: 'Ollama Embed', version: '0.1.0', status: 'running' as const, controlMode: 'observable' as const, capabilities: ['text.embed'] }];

    await connector.syncPluginServices(services);
    await connector.reportStopped(services);

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ services });
    expect(fetchImpl.mock.calls[1][0]).toBe('https://admin.example.test/api/hosts/host-1/disconnect');
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).services[0].status).toBe('offline');
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
