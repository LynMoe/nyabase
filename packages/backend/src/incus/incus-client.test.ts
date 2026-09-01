import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { describe, expect, it, vi } from 'vitest';
import busyResponse from './fixtures/busy-500.json';
import etagResponse from './fixtures/etag-412.json';
import execAcceptedResponse from './fixtures/exec-accepted.json';
import fileMetadata from './fixtures/file-metadata.json';
import instanceFullResponse from './fixtures/instance-full.json';
import operationAcceptedResponse from './fixtures/operation-accepted.json';
import serverResponse from './fixtures/server.json';
import {
  IncusClient,
  type IncusClientOptions,
  type IncusRequestFactory,
  type IncusRequestLike,
  type IncusWebSocketFactory,
  type IncusWebSocketLike,
  assertLeafCertificateFingerprint,
  leafCertificateFingerprint,
  isOperationWaitNotFound,
  readAfterTimeout,
} from './incus-client.js';
import { IncusError } from './incus-errors.js';

const leafCertificate = Buffer.from('incus-test-leaf');
const leafFingerprint = createHash('sha256').update(leafCertificate).digest('hex');

interface ResponsePlan {
  readonly status: number;
  readonly body: string | Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  readonly defer?: boolean;
}

class FakeSocket extends EventEmitter {
  private timeoutCallback?: () => void;
  connecting = true;
  secureConnecting = true;
  authorized = false;
  hasCertificate = true;

  setTimeout(_timeout: number, callback?: () => void): void {
    this.timeoutCallback = callback;
  }

  getPeerCertificate(): { readonly raw?: Buffer } {
    return this.hasCertificate ? { raw: leafCertificate } : {};
  }

  triggerTimeout(): void {
    this.timeoutCallback?.();
  }

  markSecure(): void {
    this.connecting = false;
    this.secureConnecting = false;
    this.authorized = true;
  }
}

class FakeResponse extends EventEmitter {
  readonly statusCode: number;
  readonly headers: Readonly<Record<string, string>>;

  constructor(plan: ResponsePlan) {
    super();
    this.statusCode = plan.status;
    this.headers = plan.headers ?? {};
  }
}

class FakeRequest extends EventEmitter {
  readonly socket: FakeSocket;
  readonly chunks: Buffer[] = [];
  destroyed = false;

  constructor(
    readonly options: RequestOptions,
    private readonly plan: ResponsePlan,
    private readonly callback: (response: IncomingMessage) => void,
    socket = new FakeSocket(),
    private readonly emitSecureConnect = true,
  ) {
    super();
    this.socket = socket;
  }

  setTimeout(_timeout: number, _callback?: () => void): this {
    return this;
  }

  write(chunk: string | Buffer): boolean {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }

  end(): void {
    if (this.plan.defer) return;
    queueMicrotask(() => {
      this.emit('socket', this.socket);
      if (this.emitSecureConnect) {
        this.socket.markSecure();
        this.socket.emit('secureConnect');
      }
      const response = new FakeResponse(this.plan);
      this.callback(response as unknown as IncomingMessage);
      queueMicrotask(() => {
        if (this.destroyed) return;
        if (this.plan.body !== '') response.emit('data', this.plan.body);
        response.emit('end');
      });
    });
  }

  destroy(error?: Error): this {
    this.destroyed = true;
    if (error) this.emit('error', error);
    return this;
  }
}

class RequestDriver {
  readonly requests: FakeRequest[] = [];

  constructor(
    private readonly plans: ResponsePlan[],
    private readonly sharedSocket?: FakeSocket,
    private readonly sockets?: readonly FakeSocket[],
  ) {}

  readonly factory: IncusRequestFactory = (options, callback): IncusRequestLike => {
    const plan = this.plans.shift();
    if (!plan) throw new Error('No response fixture configured');
    const socket = this.sockets?.[this.requests.length] ?? this.sharedSocket;
    const request = new FakeRequest(
      options,
      plan,
      callback,
      socket,
      this.sockets ? true : !this.sharedSocket || this.requests.length === 0,
    );
    this.requests.push(request);
    return request;
  };
}

function client(driver: RequestDriver, overrides: Partial<IncusClientOptions> = {}): IncusClient {
  return new IncusClient({
    endpoint: 'https://incus.test:8443',
    allowedHosts: ['incus.test'],
    tls: {
      cert: 'client-certificate',
      key: 'client-key',
      fingerprint: leafFingerprint,
    },
    requestFactory: driver.factory,
    ...overrides,
  });
}

function fixture(value: unknown): string {
  return JSON.stringify(value);
}

describe('IncusClient', () => {
  it('uses the bounded mTLS request transport and preserves request semantics', async () => {
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
    expect(driver.requests[0].options).toMatchObject({
      method: 'GET',
      path: '/1.0',
      hostname: 'incus.test',
    });
    expect(driver.requests[0].options.headers).toMatchObject({
      accept: 'application/json',
    });
    expect(driver.requests[1].options.path).toBe('/1.0/instances');
    expect(driver.requests[1].options.headers).toMatchObject({
      'If-Match': 'etag-1',
      'content-type': 'application/json',
      'content-length': String(
        Buffer.byteLength(
          JSON.stringify({
            name: 'nyc-11111111111141118111111111111111',
            type: 'container',
          }),
        ),
      ),
    });
    expect(driver.requests[1].chunks[0].toString('utf8')).toBe(
      JSON.stringify({
        name: 'nyc-11111111111141118111111111111111',
        type: 'container',
      }),
    );
  });

  it('verifies an already-established TLS socket reused by the HTTPS agent', async () => {
    const sharedSocket = new FakeSocket();
    const driver = new RequestDriver(
      [
        { status: 200, body: fixture(serverResponse) },
        { status: 200, body: fixture(serverResponse) },
      ],
      sharedSocket,
    );
    const incus = client(driver, {
      timeouts: { connectMs: 5, headersMs: 5, bodyMs: 5, totalMs: 20 },
    });

    await incus.getServer();
    const second = incus.getServer();
    setTimeout(() => sharedSocket.triggerTimeout(), 10);

    await expect(second).resolves.toMatchObject({ status: 200 });
    expect(driver.requests).toHaveLength(2);
  });

  it('accepts a pinned TLS session resumption without a peer certificate payload', async () => {
    const resumedSocket = new FakeSocket();
    resumedSocket.hasCertificate = false;
    const driver = new RequestDriver(
      [
        { status: 200, body: fixture(serverResponse) },
        { status: 200, body: fixture(serverResponse) },
      ],
      undefined,
      [new FakeSocket(), resumedSocket],
    );
    const incus = client(driver, {
      timeouts: { connectMs: 5, headersMs: 5, bodyMs: 5, totalMs: 20 },
    });

    await incus.getServer();

    await expect(incus.getServer()).resolves.toMatchObject({ status: 200 });
  });

  it('posts the DER certificate encoding and accepts Incus 201 sync responses', async () => {
    const certificatePem = [
      '-----BEGIN CERTIFICATE-----',
      'Y2VydGlmaWNhdGU=',
      '-----END CERTIFICATE-----',
    ].join('\n');
    const driver = new RequestDriver([
      {
        status: 201,
        body: fixture({
          type: 'sync',
          status: 'Success',
          status_code: 200,
          metadata: null,
        }),
      },
    ]);
    const incus = client(driver, {
      tls: {
        cert: certificatePem,
        key: 'client-key',
        fingerprint: leafFingerprint,
      },
    });

    const response = await incus.trustClientCertificate('trust-token', 'probe-client');

    expect(response).toMatchObject({
      status: 201,
      envelope: {
        type: 'sync',
        status_code: 200,
        metadata: null,
      },
      metadata: null,
    });
    expect(JSON.parse(driver.requests[0]!.chunks[0]!.toString('utf8'))).toEqual({
      certificate: 'Y2VydGlmaWNhdGU=',
      name: 'probe-client',
      type: 'client',
      trust_token: 'trust-token',
    });
  });

  it('deletes a client certificate by the normalized fingerprint', async () => {
    const fingerprint = Array.from({ length: 32 }, (_, index) =>
      index.toString(16).padStart(2, '0'),
    ).join(':');
    const driver = new RequestDriver([
      {
        status: 200,
        body: fixture({
          type: 'sync',
          status: 'Success',
          status_code: 200,
          metadata: {},
        }),
      },
    ]);
    const incus = client(driver);

    await expect(incus.deleteClientCertificate(fingerprint)).resolves.toMatchObject({
      status: 200,
    });
    expect(driver.requests[0]!.options).toMatchObject({
      method: 'DELETE',
      path: `/1.0/certificates/${fingerprint.replaceAll(':', '')}`,
    });
  });

  it('treats deleteClientCertificate 404 as success', async () => {
    const fingerprint = 'ab'.repeat(32);
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

    await expect(incus.deleteClientCertificate(fingerprint)).resolves.toMatchObject({
      status: 404,
      envelope: {
        type: 'sync',
        status_code: 200,
      },
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

    await incus.updateServer({ config: { 'core.https_address': ':8443' } });
    await incus.patchServer({ config: { 'core.https_address': ':8443' } });
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
    await incus.getOperation('11111111-1111-4111-8111-111111111111');
    await incus.getOperationWait('11111111-1111-4111-8111-111111111111', { timeoutMs: 1500 });

    const requestSummary = driver.requests.map((request) => ({
      method: request.options.method,
      path: request.options.path,
    }));
    expect(requestSummary).toEqual([
      { method: 'PUT', path: '/1.0' },
      { method: 'PATCH', path: '/1.0' },
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
    const body = JSON.parse(driver.requests[1].chunks[0].toString('utf8')) as {
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
    const body = JSON.parse(driver.requests[1].chunks[0].toString('utf8')) as {
      devices: Record<string, Record<string, string>>;
      profiles: string[];
    };
    expect(body.profiles).toEqual([]);
    expect(body.devices.operatorDisk).toBeUndefined();
    expect(body.devices.eth0).toBeDefined();
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

  it('honors TLS leaf fingerprint pinning and read-after-timeout contract', async () => {
    expect(leafCertificateFingerprint(leafCertificate)).toBe(leafFingerprint);
    expect(() => assertLeafCertificateFingerprint(leafCertificate, '0'.repeat(64))).toThrowError(
      'certificate did not match',
    );

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

  it('performs one-time leaf fingerprint TOFU before reusing the pin', async () => {
    const driver = new RequestDriver([
      { status: 200, body: fixture(serverResponse) },
      { status: 200, body: fixture(serverResponse) },
    ]);
    const observed: string[] = [];
    const incus = client(driver, {
      tls: {
        cert: 'client-certificate',
        key: 'client-key',
        onFirstFingerprint: (fingerprint) => {
          observed.push(fingerprint);
        },
      },
    });
    await incus.getServer();
    await incus.getServer();
    expect(observed).toEqual([leafFingerprint]);
    expect(incus.pinnedFingerprint).toBe(leafFingerprint);
  });

  it('checks the submitted expected fingerprint before invoking TOFU persistence', async () => {
    const driver = new RequestDriver([{ status: 200, body: fixture(serverResponse) }]);
    const observed: string[] = [];
    const incus = client(driver, {
      tls: {
        cert: 'client-certificate',
        key: 'client-key',
        ca: 'server-ca',
        expectedFingerprint: '0'.repeat(64),
        onFirstFingerprint: (fingerprint) => {
          observed.push(fingerprint);
        },
      },
    });

    await expect(incus.getServer()).rejects.toMatchObject({ code: 'TLS_PIN_MISMATCH' });
    expect(observed).toEqual([]);
    expect(incus.pinnedFingerprint).toBeUndefined();
  });

  it('passes pin-mode TLS options when a leaf fingerprint is configured', async () => {
    const driver = new RequestDriver([{ status: 200, body: fixture(serverResponse) }]);
    const incus = client(driver, {
      tls: {
        cert: 'client-certificate',
        key: 'client-key',
        ca: 'server-ca',
        fingerprint: leafFingerprint,
      },
      operationWaitTimeoutMs: 7_000,
    });

    await incus.getOperationWait('11111111-1111-4111-8111-111111111111');
    expect(driver.requests[0].options).toMatchObject({
      // Bootstrap CA is host-specific; pin mode disables CA rejection.
      ca: undefined,
      rejectUnauthorized: false,
    });
    expect(driver.requests[0].options.path).toBe(
      '/1.0/operations/11111111-1111-4111-8111-111111111111/wait?timeout=7',
    );
  });

  it('uses the operation wait timeout as the HTTPS deadline for a long wait', async () => {
    vi.useFakeTimers();
    try {
      const driver = new RequestDriver([{ status: 200, body: '', defer: true }]);
      const incus = client(driver, {
        timeouts: { connectMs: 5, headersMs: 5, bodyMs: 5, totalMs: 5 },
        operationWaitTimeoutMs: 50,
      });
      const pending = incus.getOperationWait('11111111-1111-4111-8111-111111111111');
      const outcome = pending.then(
        () => null,
        (error: unknown) => error,
      );

      await vi.advanceTimersByTimeAsync(49);
      expect(driver.requests[0].destroyed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(outcome).resolves.toMatchObject({
        code: 'INCUS_TIMEOUT',
        details: { phase: 'total' },
      });
      expect(driver.requests[0].destroyed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a long operation wait through the underlying HTTPS request', async () => {
    const driver = new RequestDriver([{ status: 200, body: '', defer: true }]);
    const controller = new AbortController();
    const incus = client(driver, {
      operationWaitTimeoutMs: 60_000,
    });
    const pending = incus.getOperationWait('11111111-1111-4111-8111-111111111111', {
      signal: controller.signal,
    });
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'INCUS_TIMEOUT',
      details: { phase: 'total' },
    });

    controller.abort();
    await assertion;
    expect(driver.requests[0].destroyed).toBe(true);
  });

  it('aborts a deferred request within the total timeout', async () => {
    const driver = new RequestDriver([{ status: 200, body: '', defer: true }]);
    const incus = client(driver, {
      timeouts: { connectMs: 20, headersMs: 20, bodyMs: 20, totalMs: 5 },
    });
    await expect(incus.getServer()).rejects.toMatchObject({
      code: 'INCUS_TIMEOUT',
      disposition: 'retry',
    });
    expect(driver.requests[0].destroyed).toBe(true);
  });

  it('honors an already-aborted AbortSignal without creating a socket', async () => {
    const controller = new AbortController();
    controller.abort();
    const driver = new RequestDriver([]);
    const incus = client(driver);
    await expect(incus.getServer({ signal: controller.signal })).rejects.toMatchObject({
      code: 'INCUS_TIMEOUT',
      disposition: 'retry',
    });
    expect(driver.requests).toHaveLength(0);
  });

  it('keeps exec fd secrets in the backend websocket URL and out of the session object', async () => {
    const driver = new RequestDriver([{ status: 202, body: fixture(execAcceptedResponse) }]);
    const websocketUrls: string[] = [];
    const websocketFactory: IncusWebSocketFactory = (url) => {
      websocketUrls.push(url);
      const socket = new EventEmitter() as EventEmitter & {
        close: () => void;
        send: (data: string | Buffer) => void;
      };
      socket.close = () => undefined;
      socket.send = () => undefined;
      queueMicrotask(() => socket.emit('open'));
      return socket as unknown as IncusWebSocketLike;
    };
    const incus = client(driver, { websocketFactory });
    const session = await incus.openExecWebSockets('nyc-11111111111141118111111111111111', {
      command: ['/bin/sh'],
      interactive: true,
    });

    expect(websocketUrls).toHaveLength(2);
    expect(websocketUrls.join('\n')).toContain('fixture-stdin-secret');
    expect(websocketUrls.join('\n')).toContain('fixture-control-secret');
    expect(JSON.stringify(session)).not.toContain('fixture-stdin-secret');
    expect(JSON.stringify(session)).not.toContain('fixture-control-secret');
    session.close();
  });
});
