import { describe, expect, it } from 'vitest';
import busyResponse from './fixtures/busy-500.json';
import etagResponse from './fixtures/etag-412.json';
import execAcceptedResponse from './fixtures/exec-accepted.json';
import fileMetadata from './fixtures/file-metadata.json';
import instanceFullResponse from './fixtures/instance-full.json';
import operationAcceptedResponse from './fixtures/operation-accepted.json';
import serverResponse from './fixtures/server.json';
import { IncusClient } from './incus-client.js';
import type {
  IncusClientOptions,
  IncusTunnel,
  IncusTunnelRequest,
  IncusWebSocketLike,
} from './incus-client-types.js';
import { isOperationWaitNotFound, readAfterTimeout } from './incus-operation.js';
import { encodeImageAliasName } from './incus-transport.js';
import { IncusError } from './incus-errors.js';

interface ResponsePlan {
  readonly status: number;
  readonly body: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
}

interface RecordedRequest {
  readonly options: IncusTunnelRequest;
  readonly body: Buffer | undefined;
}

/** Stands in for the agent: answers each request from a fixture plan. */
class RequestDriver implements IncusTunnel {
  readonly requests: RecordedRequest[] = [];
  readonly websocketPaths: string[] = [];

  constructor(private readonly plans: ResponsePlan[]) {}

  async request(options: IncusTunnelRequest) {
    if (options.signal?.aborted) {
      throw new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total', reason: 'aborted' });
    }
    this.requests.push({ options, body: options.body });
    const plan = this.plans.shift();
    if (!plan) throw new Error('No response fixture configured');
    return {
      status: plan.status,
      headers: { ...(plan.headers ?? {}) },
      body: Buffer.isBuffer(plan.body) ? plan.body : Buffer.from(plan.body),
    };
  }

  async openWebSocket(path: string): Promise<IncusWebSocketLike> {
    this.websocketPaths.push(path);
    return {
      on() {
        return this;
      },
      once() {
        return this;
      },
      send: () => undefined,
      close: () => undefined,
    } as IncusWebSocketLike;
  }
}

function client(driver: RequestDriver, overrides: Partial<IncusClientOptions> = {}): IncusClient {
  return new IncusClient({ tunnel: driver, ...overrides });
}

function fixture(value: unknown): string {
  return JSON.stringify(value);
}

describe('encodeImageAliasName', () => {
  it('encodes slashy catalog aliases without using encodeSegment rules', () => {
    expect(encodeImageAliasName('ubuntu/24.04')).toBe('ubuntu%2F24.04');
    expect(encodeImageAliasName('ubuntu/noble/default')).toBe('ubuntu%2Fnoble%2Fdefault');
  });

  it('rejects empty, dot, and backslash names', () => {
    expect(() => encodeImageAliasName('')).toThrow();
    expect(() => encodeImageAliasName('.')).toThrow();
    expect(() => encodeImageAliasName('..')).toThrow();
    expect(() => encodeImageAliasName('ubuntu\\24.04')).toThrow();
  });
});

describe('IncusClient', () => {
  it('sends requests through the agent tunnel and preserves request semantics', async () => {
    const driver = new RequestDriver([
      { status: 200, body: fixture(serverResponse) },
      { status: 202, body: fixture(operationAcceptedResponse) },
    ]);
    const incus = client(driver);

    const server = await incus.getServer();
    await incus.createInstance(
      {
        name: 'nyc-11111111111141118111111111111111',
        type: 'container',
      },
      { ifMatch: 'etag-1' },
    );

    expect(server.metadata.api_version).toBe('1.0');
    expect(driver.requests[0].options).toMatchObject({ method: 'GET', path: '/1.0' });
    expect(driver.requests[1].options.path).toBe('/1.0/instances');
    expect(driver.requests[1].options.headers).toMatchObject({
      'If-Match': 'etag-1',
      'content-type': 'application/json',
    });
    expect(driver.requests[1].body!.toString('utf8')).toBe(
      JSON.stringify({
        name: 'nyc-11111111111141118111111111111111',
        type: 'container',
      }),
    );
  });

  it('treats deleteImageAlias 404 as success', async () => {
    const driver = new RequestDriver([
      {
        status: 404,
        body: fixture({
          type: 'error',
          status_code: 0,
          error_code: 404,
          error: 'Not Found',
          metadata: null,
        }),
      },
    ]);
    const incus = client(driver);

    await expect(incus.deleteImageAlias('ubuntu/24.04')).resolves.toMatchObject({
      status: 404,
      envelope: {
        type: 'sync',
        status_code: 200,
      },
    });
    expect(driver.requests[0]!.options).toMatchObject({
      method: 'DELETE',
      path: '/1.0/images/aliases/ubuntu%2F24.04',
    });
  });

  it('covers the canonical server, instance, storage, image, and operation endpoints', async () => {
    const responsePlans = Array.from({ length: 31 }, () => ({
      status: 200,
      body: fixture(serverResponse),
    }));
    const driver = new RequestDriver(responsePlans);
    const incus = client(driver);
    const instanceName = 'nyc-11111111111141118111111111111111';
    const volumeName = 'nyv-33333333333343338333333333333333';
    const fingerprint = 'a'.repeat(64);

    await incus.getResources();
    await incus.getNetwork('vmbr0');
    await incus.getNetworkState('vmbr0');
    await incus.listNetworks();
    await incus.listInstances();
    await incus.getInstance(instanceName);
    await incus.getInstanceFull(instanceName);
    await incus.updateInstance(instanceName, { config: {} });
    await incus.patchInstance(instanceName, { config: {} });
    await incus.deleteInstance(instanceName);
    await incus.getInstanceState(instanceName);
    await incus.updateInstanceState(instanceName, { action: 'start' });
    await incus.execInstance(instanceName, { command: ['/bin/true'] });
    await incus.listStoragePools();
    await incus.getStoragePool('default');
    await incus.getStoragePoolResources('default');
    await incus.listStorageVolumes('default');
    await incus.getStorageVolume('default', 'custom', volumeName);
    await incus.getStorageVolumeState('default', 'custom', volumeName);
    await incus.createStorageVolume('default', {
      name: volumeName,
      type: 'custom',
      config: { size: '1GiB' },
    });
    await incus.updateStorageVolume('default', 'custom', volumeName, {
      config: { size: '2GiB' },
    });
    await incus.deleteStorageVolume('default', 'custom', volumeName);
    await incus.listImages();
    await incus.getImage(fingerprint);
    await incus.createImage({});
    await incus.updateImage(fingerprint, {});
    await incus.deleteImage(fingerprint);
    await incus.createImageAlias({ name: 'ubuntu/24.04', target: fingerprint });
    await incus.deleteImageAlias('ubuntu/24.04');
    await incus.getOperation('11111111-1111-4111-8111-111111111111');
    await incus.getOperationWait('11111111-1111-4111-8111-111111111111', { timeoutMs: 1500 });

    const requestSummary = driver.requests.map((request) => ({
      method: request.options.method,
      path: request.options.path,
    }));
    expect(requestSummary).toEqual([
      { method: 'GET', path: '/1.0/resources' },
      { method: 'GET', path: '/1.0/networks/vmbr0' },
      { method: 'GET', path: '/1.0/networks/vmbr0/state' },
      { method: 'GET', path: '/1.0/networks' },
      { method: 'GET', path: '/1.0/instances?recursion=2' },
      { method: 'GET', path: `/1.0/instances/${instanceName}` },
      { method: 'GET', path: `/1.0/instances/${instanceName}?recursion=1` },
      { method: 'PUT', path: `/1.0/instances/${instanceName}` },
      { method: 'PATCH', path: `/1.0/instances/${instanceName}` },
      { method: 'DELETE', path: `/1.0/instances/${instanceName}` },
      { method: 'GET', path: `/1.0/instances/${instanceName}/state` },
      { method: 'PUT', path: `/1.0/instances/${instanceName}/state` },
      { method: 'POST', path: `/1.0/instances/${instanceName}/exec` },
      { method: 'GET', path: '/1.0/storage-pools?recursion=1' },
      { method: 'GET', path: '/1.0/storage-pools/default' },
      { method: 'GET', path: '/1.0/storage-pools/default/resources' },
      { method: 'GET', path: '/1.0/storage-pools/default/volumes/custom?recursion=1' },
      { method: 'GET', path: `/1.0/storage-pools/default/volumes/custom/${volumeName}` },
      { method: 'GET', path: `/1.0/storage-pools/default/volumes/custom/${volumeName}/state` },
      { method: 'POST', path: '/1.0/storage-pools/default/volumes' },
      { method: 'PUT', path: `/1.0/storage-pools/default/volumes/custom/${volumeName}` },
      { method: 'DELETE', path: `/1.0/storage-pools/default/volumes/custom/${volumeName}` },
      { method: 'GET', path: '/1.0/images?recursion=1' },
      { method: 'GET', path: `/1.0/images/${fingerprint}` },
      { method: 'POST', path: '/1.0/images' },
      { method: 'PUT', path: `/1.0/images/${fingerprint}` },
      { method: 'DELETE', path: `/1.0/images/${fingerprint}` },
      { method: 'POST', path: '/1.0/images/aliases' },
      { method: 'DELETE', path: '/1.0/images/aliases/ubuntu%2F24.04' },
      { method: 'GET', path: '/1.0/operations/11111111-1111-4111-8111-111111111111' },
      {
        method: 'GET',
        path: '/1.0/operations/11111111-1111-4111-8111-111111111111/wait?timeout=2',
      },
    ]);
  });

  it('rejects path injection before a request is created', async () => {
    const driver = new RequestDriver([]);
    const incus = client(driver);
    expect(() => incus.getInstance('bad/name')).toThrowError(
      expect.objectContaining({
        code: 'INCUS_BAD_REQUEST',
      }),
    );
    expect(() => incus.getInstance('..')).toThrowError(
      expect.objectContaining({
        code: 'INCUS_BAD_REQUEST',
      }),
    );
    expect(driver.requests).toHaveLength(0);
  });

  it('maps ETag precondition failures and strict busy text from HTTP 500', async () => {
    const driver = new RequestDriver([
      { status: 412, body: fixture(etagResponse) },
      { status: 500, body: fixture(busyResponse) },
    ]);
    const incus = client(driver);

    await expect(
      incus.updateInstance(
        'nyc-11111111111141118111111111111111',
        { config: {} },
        { ifMatch: '"etag-2' },
      ),
    ).rejects.toMatchObject({ code: 'ETAG_CONFLICT', disposition: 'retry' });
    await expect(
      incus.updateInstance('nyc-11111111111141118111111111111111', { config: {} }),
    ).rejects.toMatchObject({
      code: 'INSTANCE_BUSY',
      disposition: 'retry',
      details: { action: 'start' },
    });
  });

  it('maps Incus error envelopes with a zero status_code from their error_code', async () => {
    const driver = new RequestDriver([
      {
        status: 400,
        body: fixture({
          type: 'error',
          status_code: 0,
          error_code: 400,
          error: 'illegal base64 data at input byte 0',
          metadata: null,
        }),
      },
    ]);
    const incus = client(driver);

    await expect(incus.getServer()).rejects.toMatchObject({
      code: 'INCUS_BAD_REQUEST',
      disposition: 'managed_failure',
      details: {
        status: 400,
        apiErrorCode: 400,
      },
    });
  });

  it('includes the exact request path when mapping an operation wait 404', async () => {
    const operationId = '11111111-1111-4111-8111-111111111111';
    const driver = new RequestDriver([
      {
        status: 404,
        body: fixture({
          type: 'error',
          status_code: 0,
          error_code: 404,
          error: 'Operation not found',
          metadata: null,
        }),
      },
    ]);
    const incus = client(driver);

    await expect(incus.getOperationWait(operationId, { timeoutMs: 7_000 })).rejects.toMatchObject({
      code: 'INCUS_NOT_FOUND',
      details: {
        status: 404,
        apiErrorCode: 404,
        error: 'Operation not found',
        path: `/1.0/operations/${operationId}/wait?timeout=7`,
      },
    });
  });

  it('reads a full instance, preserves operator fields, and writes with If-Match', async () => {
    const driver = new RequestDriver([
      {
        status: 200,
        body: fixture(instanceFullResponse),
        headers: { etag: 'etag-actual' },
      },
      { status: 200, body: fixture(serverResponse) },
    ]);
    const incus = client(driver);
    await incus.readModifyWriteInstance('nyc-11111111111141118111111111111111', (document) => {
      document.config ??= {};
      document.config['limits.cpu'] = '2';
      return document;
    });
    expect(driver.requests[1].options.headers).toMatchObject({
      'If-Match': 'etag-actual',
    });
    const body = JSON.parse(driver.requests[1].body!.toString('utf8')) as {
      config: Record<string, string>;
      devices: Record<string, Record<string, string>>;
      profiles: string[];
    };
    expect(body.config['volatile.eth0.hwaddr']).toBe('02:aa:bb:cc:dd:ee');
    expect(body.config['operator.note']).toBe('preserve');
    expect(body.devices.operatorDisk).toBeDefined();
    expect(body.config['limits.cpu']).toBe('2');
    expect(body.profiles).toEqual([]);
  });

  it('pins RMW profiles to empty and persists mutate device stripping', async () => {
    const driver = new RequestDriver([
      {
        status: 200,
        body: fixture(instanceFullResponse),
        headers: { etag: 'etag-actual' },
      },
      { status: 200, body: fixture(serverResponse) },
    ]);
    const incus = client(driver);
    await incus.readModifyWriteInstance('nyc-11111111111141118111111111111111', (document) => {
      document.profiles = ['default'];
      const devices = { ...(document.devices ?? {}) };
      delete devices.operatorDisk;
      document.devices = devices;
      return document;
    });
    const body = JSON.parse(driver.requests[1].body!.toString('utf8')) as {
      devices: Record<string, Record<string, string>>;
      profiles: string[];
    };
    expect(body.profiles).toEqual([]);
    expect(body.devices.operatorDisk).toBeUndefined();
    expect(body.devices.eth0).toBeDefined();
  });

  it('passes the operation wait timeout and abort signal to the tunnel', async () => {
    const driver = new RequestDriver([{ status: 200, body: fixture(serverResponse) }]);
    const controller = new AbortController();
    const incus = client(driver, { operationWaitTimeoutMs: 50_000 });
    await incus.getOperationWait('11111111-1111-4111-8111-111111111111', { signal: controller.signal });
    expect(driver.requests[0].options.timeoutMs).toBe(50_000);
    expect(driver.requests[0].options.signal).toBe(controller.signal);
    expect(driver.requests[0].options.path).toBe(
      '/1.0/operations/11111111-1111-4111-8111-111111111111/wait?timeout=50',
    );
  });

  it('surfaces tunnel failures unchanged', async () => {
    const incus = new IncusClient({
      tunnel: {
        request: async () => {
          throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected' });
        },
        openWebSocket: async () => {
          throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected' });
        },
      },
    });
    await expect(incus.getServer()).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE', disposition: 'retry' });
  });

  it('enforces the response body limit', async () => {
    const driver = new RequestDriver([{ status: 200, body: '12345' }]);
    const incus = client(driver, { maxBodyBytes: 4 });
    await expect(incus.getServer()).rejects.toMatchObject({
      code: 'INCUS_INVALID_RESPONSE',
      details: { reason: 'body_too_large' },
    });
  });

  it('returns raw file bytes and Incus file metadata without parsing the body', async () => {
    const driver = new RequestDriver([
      {
        status: 200,
        body: fileMetadata.body,
        headers: fileMetadata.headers,
      },
      { status: 200, body: fixture(serverResponse) },
    ]);
    const incus = client(driver);
    const file = await incus.getFile(
      'nyc-11111111111141118111111111111111',
      '/root/.ssh/authorized_keys',
      { project: 'default' },
    );
    expect(file).toMatchObject({
      body: Buffer.from(fileMetadata.body),
      uid: 1000,
      gid: 1000,
      mode: 384,
      type: 'file',
      modified: '2026-08-06T17:00:00Z',
    });
    expect(driver.requests[0].options.path).toBe(
      '/1.0/instances/nyc-11111111111141118111111111111111/files?path=%2Froot%2F.ssh%2Fauthorized_keys&project=default',
    );
    await incus.putFile('nyc-11111111111141118111111111111111', '/tmp/key', Buffer.from('key'), {
      uid: 1000,
      gid: 1000,
      mode: 384,
      type: 'file',
      write: 'overwrite',
    });
    expect(driver.requests[1].options.headers).toMatchObject({
      'X-Incus-uid': '1000',
      'X-Incus-gid': '1000',
      'X-Incus-mode': '0600',
      'X-Incus-type': 'file',
      'X-Incus-write': 'overwrite',
    });
  });

  it('parses zero-padded octal x-incus-mode headers from live Incus', async () => {
    const driver = new RequestDriver([
      {
        status: 200,
        body: 'ssh-ed25519 AAAA root\n',
        headers: {
          'x-incus-uid': '0',
          'x-incus-gid': '0',
          'x-incus-mode': '0600',
          'x-incus-type': 'file',
        },
      },
    ]);
    const incus = client(driver);
    const file = await incus.getFile(
      'nyc-11111111111141118111111111111111',
      '/root/.ssh/authorized_keys',
    );
    expect(file).toMatchObject({
      uid: 0,
      gid: 0,
      mode: 0o600,
      type: 'file',
    });
  });

  it('honors the read-after-timeout contract', async () => {
    let reads = 0;
    await expect(
      readAfterTimeout(
        async () => {
          throw new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total' });
        },
        async () => {
          reads += 1;
          return 'observed';
        },
      ),
    ).resolves.toBe('observed');
    expect(reads).toBe(1);

    const wait404 = new IncusError('INCUS_NOT_FOUND', 'managed_failure', {
      path: '/1.0/operations/11111111-1111-4111-8111-111111111111/wait?timeout=7',
    });
    expect(isOperationWaitNotFound(wait404)).toBe(true);
    await expect(
      readAfterTimeout(
        async () => {
          throw wait404;
        },
        async () => 'observed-after-wait-404',
      ),
    ).resolves.toBe('observed-after-wait-404');

    await expect(
      readAfterTimeout(
        async () => {
          throw wait404;
        },
        async () => {
          throw new IncusError('INCUS_NOT_FOUND', 'managed_failure', {
            path: '/1.0/instances/nyc-missing',
          });
        },
      ),
    ).rejects.toBe(wait404);

    const instance404 = new IncusError('INCUS_NOT_FOUND', 'managed_failure', {
      path: '/1.0/instances/nyc-missing',
    });
    expect(isOperationWaitNotFound(instance404)).toBe(false);
    await expect(
      readAfterTimeout(
        async () => {
          throw instance404;
        },
        async () => 'should-not-read',
      ),
    ).rejects.toBe(instance404);
  });

  it('keeps exec fd secrets in the backend websocket URL and out of the session object', async () => {
    const driver = new RequestDriver([{ status: 202, body: fixture(execAcceptedResponse) }]);
    const incus = client(driver);
    const session = await incus.openExecWebSockets('nyc-11111111111141118111111111111111', {
      command: ['/bin/sh'],
      interactive: true,
    });

    expect(driver.websocketPaths).toHaveLength(2);
    expect(driver.websocketPaths.join('\n')).toContain('fixture-stdin-secret');
    expect(driver.websocketPaths.join('\n')).toContain('fixture-control-secret');
    expect(driver.websocketPaths.every((path) => path.startsWith('/1.0/operations/'))).toBe(true);
    expect(JSON.stringify(session)).not.toContain('fixture-stdin-secret');
    expect(JSON.stringify(session)).not.toContain('fixture-control-secret');
    session.close();
  });

  it('closes a channel that opens after a sibling channel failed to dial', async () => {
    const closed: string[] = [];
    let releaseStdin!: () => void;
    const stdinGate = new Promise<void>((resolve) => { releaseStdin = resolve; });
    class FailingControlDriver extends RequestDriver {
      override async openWebSocket(path: string): Promise<IncusWebSocketLike> {
        if (path.includes('fixture-control-secret')) {
          // stdin is still dialing when control fails.
          setTimeout(releaseStdin, 10);
          throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'control' });
        }
        await stdinGate;
        const socket = await super.openWebSocket(path);
        socket.close = () => { closed.push('stdin'); };
        return socket;
      }
    }
    const incus = client(new FailingControlDriver([{ status: 202, body: fixture(execAcceptedResponse) }]));

    await expect(incus.openExecWebSockets('nyc-11111111111141118111111111111111', {
      command: ['/bin/sh'],
      interactive: true,
    })).rejects.toMatchObject({ code: 'SERVER_UNREACHABLE' });
    expect(closed).toEqual(['stdin']);
  });
});
