import { expect } from './expect.js';
import type { ApiResponse } from './api-client.js';

type ExpectedStatus = number | readonly number[];

export async function expectJson<T>(
  response: ApiResponse,
  status: ExpectedStatus = 200,
): Promise<T> {
  const body = await response.text();
  const expectedStatuses = Array.isArray(status) ? status : [status];
  expect(
    expectedStatuses.includes(response.status()),
    `${response.url()} returned ${response.status()}, expected ${expectedStatuses.join(' or ')}; body=${body.slice(0, 800)}`,
  ).toBe(true);
  expect(response.headers()['content-type'] ?? '').toContain('application/json');
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(
      `${response.url()} returned an invalid JSON body (${Buffer.byteLength(body)} bytes); response body withheld`,
    );
  }
}

export async function expectSuccess(response: ApiResponse): Promise<void> {
  expect(
    response.ok(),
    `${response.url()} returned ${response.status()}; response body withheld`,
  ).toBe(true);
}
