import type { ApiClient } from './api-client.js';

export async function waitForGone(
  api: ApiClient,
  path: string,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  do {
    const response = await api.get(path);
    if (response.status() === 404) return;
    if (response.status() === 401 || response.status() === 403) {
      throw new Error(`auth lost while waiting for gone: ${path} status=${response.status()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new Error(`resource was not removed: ${path}`);
}
