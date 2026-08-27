import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createMetricsRequestHandler } from './server.js';

interface FakeResponse {
  readonly response: ServerResponse;
  readonly state: {
    status: number | null;
    headers: Record<string, string | number>;
    body: string;
    destroyed: boolean;
  };
}

function fakeRequest(
  url: string,
  method: string,
  authorization?: string,
): IncomingMessage {
  return {
    url,
    method,
    headers: authorization ? { authorization } : {},
  } as IncomingMessage;
}

function fakeResponse(): FakeResponse {
  const state = {
    status: null as number | null,
    headers: {} as Record<string, string | number>,
    body: '',
    destroyed: false,
  };
  const response = {
    headersSent: false,
    setHeader(name: string, value: string | number) {
      state.headers[name.toLowerCase()] = value;
    },
    writeHead(status: number, headers: Record<string, string | number>) {
      state.status = status;
      Object.assign(state.headers, Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
      ));
      (response as { headersSent: boolean }).headersSent = true;
    },
    end(body?: string) {
      state.body = body ?? '';
    },
    destroy() {
      state.destroyed = true;
    },
  } as unknown as ServerResponse;
  return { response, state };
}

async function runRequest(
  url: string,
  method: string,
  authorization?: string,
  collector = { collect: vi.fn().mockResolvedValue([{
    name: 'nyabase_node_network_forwarding',
    labels: { interface: 'eno1' },
    value: 1,
  }]) },
) {
  const handler = createMetricsRequestHandler({
    token: 'node-secret',
    collector,
  });
  const result = fakeResponse();
  handler(fakeRequest(url, method, authorization), result.response);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { ...result, collector };
}

describe('node exporter HTTP boundary', () => {
  it('requires the exact bearer token for the HTTPS metrics route', async () => {
    const unauthorized = await runRequest('/metrics', 'GET', 'Bearer wrong');
    expect(unauthorized.state.status).toBe(401);
    expect(unauthorized.state.headers['www-authenticate']).toBe('Bearer');
    expect(unauthorized.collector.collect).not.toHaveBeenCalled();

    const authorized = await runRequest('/metrics', 'GET', 'Bearer node-secret');
    expect(authorized.state.status).toBe(200);
    expect(authorized.state.body).toContain('nyabase_node_network_forwarding');
  });

  it('rejects query strings, alternate paths, and non-GET methods', async () => {
    expect((await runRequest('/metrics?format=prometheus', 'GET', 'Bearer node-secret')).state.status)
      .toBe(404);
    expect((await runRequest('/health', 'GET', 'Bearer node-secret')).state.status).toBe(404);
    const post = await runRequest('/metrics', 'POST', 'Bearer node-secret');
    expect(post.state.status).toBe(405);
    expect(post.state.headers.allow).toBe('GET');
  });

  it('returns a bounded failure when collection exceeds the timeout', async () => {
    const response = fakeResponse();
    const handler = createMetricsRequestHandler({
      token: 'node-secret',
      collectionTimeoutMs: 1,
      collector: { collect: () => new Promise<never>(() => undefined) },
    });
    handler(fakeRequest('/metrics', 'GET', 'Bearer node-secret'), response.response);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(response.state.status).toBe(503);
  });
});
