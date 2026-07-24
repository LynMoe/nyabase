import { describe, expect, it, vi } from 'vitest';
import { canDismissOneTimeSecret, copyOneTimeSecret } from './one-time-secret.js';

describe('one-time secret copy', () => {
  it('acknowledges only an awaited successful clipboard write', async () => {
    const writeText = vi.fn(async () => undefined);
    await expect(copyOneTimeSecret('secret', { writeText })).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('secret');
  });

  it('reports unavailable or rejected clipboard writes', async () => {
    await expect(copyOneTimeSecret('secret', undefined)).resolves.toBe(false);
    await expect(copyOneTimeSecret('secret', {
      writeText: vi.fn(async () => { throw new Error('denied'); }),
    })).resolves.toBe(false);
  });

  it('blocks dismissal until a displayed secret is explicitly acknowledged', () => {
    expect(canDismissOneTimeSecret('secret', false)).toBe(false);
    expect(canDismissOneTimeSecret('secret', true)).toBe(true);
    expect(canDismissOneTimeSecret(null, false)).toBe(true);
  });
});
