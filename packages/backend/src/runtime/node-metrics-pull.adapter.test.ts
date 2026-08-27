import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const { requestMock } = vi.hoisted(() => ({
  requestMock: vi.fn(),
}));

vi.mock('node:https', () => ({
  request: requestMock,
}));

import { AuthenticatedNodeMetricsPullAdapter } from './node-metrics-pull.adapter.js';

function database() {
  return {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn().mockResolvedValue({
            node_metrics_server_cert_fingerprint: null,
          }),
        })),
      })),
    })),
  };
}

function config() {
  return configWithSecret('test-secret');
}

function configWithSecret(secret: string, key: 'auth.jwtSecret' | 'ssh.keyEncryptionSecret' = 'auth.jwtSecret') {
  const values: Record<string, string> = { [key]: secret };
  const get = vi.fn((name: string) => values[name] ?? '');
  return {
    get,
    keyEncryptionSecret: vi.fn(() => {
      const dedicated = values['ssh.keyEncryptionSecret']?.trim() ?? '';
      if (dedicated) return dedicated;
      return values['auth.jwtSecret'] || 'test-secret';
    }),
  };
}

function pinnedDatabase(fingerprint: string) {
  return {
    selectFrom: vi.fn(() => ({
      select: vi.fn(() => ({
        where: vi.fn(() => ({
          executeTakeFirst: vi.fn().mockResolvedValue({
            node_metrics_server_cert_fingerprint: fingerprint,
          }),
        })),
      })),
    })),
  };
}

function encryptedToken(secret: string, token: string): string {
  const key = createHash('sha256').update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    'rfs-v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

describe('AuthenticatedNodeMetricsPullAdapter', () => {
  it('returns a typed failure when the authenticated exporter contract is unconfigured', async () => {
    const adapter = new AuthenticatedNodeMetricsPullAdapter(
      database() as never,
      config() as never,
    );

    await expect(adapter.pull(
      '00000000-0000-4000-8000-000000000001',
      'https://metrics.example.test/metrics',
      null,
    )).rejects.toMatchObject({
      name: 'NodeMetricsPullError',
      code: 'NODE_METRICS_UNCONFIGURED',
    });
  });

  it('rejects plaintext or credential-bearing endpoints before sending a bearer token', async () => {
    const adapter = new AuthenticatedNodeMetricsPullAdapter(
      database() as never,
      config() as never,
    );

    await expect(adapter.pull(
      '00000000-0000-4000-8000-000000000001',
      'http://metrics.example.test/metrics',
      'token',
    )).rejects.toMatchObject({
      name: 'NodeMetricsPullError',
      code: 'NODE_METRICS_INVALID_ENDPOINT',
    });
  });

  it('does not reuse TLS sessions before checking the pinned exporter certificate', async () => {
    const rawCertificate = Buffer.from('test-leaf-certificate');
    const fingerprint = createHash('sha256').update(rawCertificate).digest('hex');
    const secret = 'test-secret';
    const tokenCiphertext = encryptedToken(secret, 'node-token');
    let requestCount = 0;

    requestMock.mockImplementation(
      (
        options: { readonly agent?: unknown },
        callback: (response: EventEmitter & {
          readonly headers: Record<string, string>;
          readonly statusCode: number;
          readonly socket: { getPeerCertificate: () => { raw?: Buffer } };
        }) => void,
      ) => {
        const handle = new EventEmitter() as EventEmitter & {
          destroy: ReturnType<typeof vi.fn>;
          end: ReturnType<typeof vi.fn>;
        };
        handle.destroy = vi.fn();
        handle.end = vi.fn();
        queueMicrotask(() => {
          const socket = new EventEmitter();
          handle.emit('socket', socket);
          socket.emit('secureConnect');
          const response = new EventEmitter() as EventEmitter & {
            readonly headers: Record<string, string>;
            readonly statusCode: number;
            readonly socket: { getPeerCertificate: () => { raw?: Buffer } };
          };
          Object.defineProperties(response, {
            headers: { value: { 'content-type': 'text/plain; version=0.0.4' } },
            statusCode: { value: 200 },
            socket: {
              value: {
                getPeerCertificate: () =>
                  options.agent === false || requestCount === 0
                    ? { raw: rawCertificate }
                    : {},
              },
            },
          });
          requestCount += 1;
          callback(response);
          response.emit('data', 'nyabase_node_cpu_usage_ratio{cpu="0"} 1\n');
          response.emit('end');
        });
        return handle;
      },
    );

    const adapter = new AuthenticatedNodeMetricsPullAdapter(
      pinnedDatabase(fingerprint) as never,
      configWithSecret(secret, 'ssh.keyEncryptionSecret') as never,
    );

    await expect(adapter.pull(
      '00000000-0000-4000-8000-000000000001',
      'https://metrics.example.test/metrics',
      tokenCiphertext,
    )).resolves.toMatchObject({ status: 'online' });
    await expect(adapter.pull(
      '00000000-0000-4000-8000-000000000001',
      'https://metrics.example.test/metrics',
      tokenCiphertext,
    )).resolves.toMatchObject({ status: 'online' });

    expect(requestMock).toHaveBeenCalledTimes(2);
    expect(requestMock.mock.calls[0]?.[0]).toMatchObject({ agent: false });
    expect(requestMock.mock.calls[1]?.[0]).toMatchObject({ agent: false });
    requestMock.mockReset();
  });
});
