import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EnrollmentRejectedError, enroll, enrollUntilAccepted } from './enroll.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const CREDENTIAL = `nyak.${SERVER_ID}.${'a'.repeat(43)}`;

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

async function backendAnswering(status: number, payload: unknown = {}): Promise<URL> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(payload));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
}

describe('enrollment exchange', () => {
  it('treats throttling and server errors as retryable, a refused token as final', async () => {
    for (const status of [408, 429, 500, 503]) {
      const error = await enroll({ backendUrl: await backendAnswering(status) }, 'nyae.x.y').catch((caught) => caught);
      expect(error, String(status)).toBeInstanceOf(Error);
      expect(error, String(status)).not.toBeInstanceOf(EnrollmentRejectedError);
    }
    for (const status of [400, 401, 403]) {
      await expect(enroll({ backendUrl: await backendAnswering(status) }, 'nyae.x.y'), String(status))
        .rejects.toBeInstanceOf(EnrollmentRejectedError);
    }
    await expect(enroll({ backendUrl: await backendAnswering(200, { serverId: SERVER_ID, credential: CREDENTIAL }) }, 'nyae.x.y'))
      .resolves.toEqual({ serverId: SERVER_ID, credential: CREDENTIAL });
  });
});

describe('enrollment retries', () => {
  it('retries transport failures and failed writes with the same token until the credential is stored', async () => {
    const exchange = vi.fn()
      .mockRejectedValueOnce(new Error('Enrollment request timed out'))
      .mockResolvedValueOnce({ serverId: SERVER_ID, credential: 'first' })
      .mockResolvedValueOnce({ serverId: SERVER_ID, credential: CREDENTIAL });
    const write = vi.fn()
      .mockRejectedValueOnce(new Error('ENOSPC'))
      .mockResolvedValueOnce(undefined);
    const log = vi.fn();
    await expect(enrollUntilAccepted('nyae.token', new AbortController().signal, {
      exchange,
      store: { write },
      log,
      initialDelayMs: 1,
      maxDelayMs: 4,
    })).resolves.toBe(CREDENTIAL);
    expect(exchange).toHaveBeenCalledTimes(3);
    expect(exchange.mock.calls.every(([token]) => token === 'nyae.token')).toBe(true);
    expect(write).toHaveBeenLastCalledWith(CREDENTIAL);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^enrollment failed, retrying/));
  });

  it('gives up on a rejected token', async () => {
    const exchange = vi.fn().mockRejectedValue(new EnrollmentRejectedError('Enrollment rejected (401)'));
    await expect(enrollUntilAccepted('nyae.token', new AbortController().signal, {
      exchange,
      store: { write: vi.fn() },
      log: vi.fn(),
      initialDelayMs: 1,
    })).rejects.toBeInstanceOf(EnrollmentRejectedError);
    expect(exchange).toHaveBeenCalledTimes(1);
  });

  it('stops waiting between attempts when the agent is shutting down', async () => {
    const controller = new AbortController();
    const exchange = vi.fn(async () => {
      queueMicrotask(() => controller.abort());
      throw new Error('ECONNREFUSED');
    });
    await expect(enrollUntilAccepted('nyae.token', controller.signal, {
      exchange,
      store: { write: vi.fn() },
      log: vi.fn(),
      initialDelayMs: 60_000,
    })).rejects.toThrow('stopped before enrollment completed');
  });
});
