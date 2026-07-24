import { describe, expect, it, vi } from 'vitest';
import { runSessionTermination } from './session-termination.js';

describe('browser session termination orchestration', () => {
  it('revokes exactly the session captured before local cleanup', async () => {
    const old = { accessToken: 'old-a', refreshToken: 'old-r' };
    const clear = vi.fn(() => old);
    const revoke = vi.fn(async () => undefined);
    await runSessionTermination(clear, revoke);
    expect(clear).toHaveBeenCalledOnce();
    expect(revoke).toHaveBeenCalledWith(old);
  });

  it('contains best-effort revocation failure after local cleanup', async () => {
    const clear = vi.fn(() => ({ accessToken: null, refreshToken: 'old-r' }));
    await expect(runSessionTermination(clear, async () => { throw new Error('offline'); }))
      .resolves.toBeUndefined();
    expect(clear).toHaveBeenCalledOnce();
  });
});
