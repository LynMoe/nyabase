import { describe, expect, it, vi } from 'vitest';
import { freshAccessTokenWithRetry } from './api.js';

function clock() {
  let at = 0;
  return {
    now: () => at,
    sleep: vi.fn(async (ms: number) => { at += ms; }),
  };
}

describe('freshAccessTokenWithRetry', () => {
  it('keeps asking with backoff until a token arrives for the re-authentication prompt', async () => {
    const time = clock();
    const fetchToken = vi.fn<(previous: string | null) => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('fresh');

    await expect(freshAccessTokenWithRetry('old', () => true, { fetchToken, ...time })).resolves.toBe('fresh');
    expect(fetchToken).toHaveBeenCalledTimes(3);
    expect(fetchToken).toHaveBeenCalledWith('old');
    expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000]);
  });

  it('stops once the console socket is no longer open', async () => {
    const time = clock();
    let open = true;
    const fetchToken = vi.fn(async () => {
      open = false;
      return null;
    });

    await expect(freshAccessTokenWithRetry('old', () => open, { fetchToken, ...time })).resolves.toBeNull();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it('gives up once the console deadline has certainly passed', async () => {
    const time = clock();
    const fetchToken = vi.fn(async () => null);

    await expect(freshAccessTokenWithRetry('old', () => true, { fetchToken, ...time })).resolves.toBeNull();
    // 1 + 2 + 4 + 8 + 15 + 15 s, the next wait would cross the 60 s bound.
    expect(time.sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000, 8_000, 15_000, 15_000]);
    expect(time.now()).toBeLessThan(60_000);
  });
});
