import { describe, expect, it } from 'vitest';
import { imageGrantAction } from './image-grant-action.js';

describe('imageGrantAction', () => {
  it('adds and removes exactly one user/image/server cell', () => {
    expect(imageGrantAction({ type: 'user', id: 'u1' }, 'i1', 's1', false)).toEqual({
      method: 'POST',
      path: '/admin/users/u1/image-grants',
      body: { imageId: 'i1', serverId: 's1' },
    });
    expect(imageGrantAction({ type: 'user', id: 'u1' }, 'i1', 's1', true)).toEqual({
      method: 'DELETE',
      path: '/admin/users/u1/image-grants/i1/s1',
    });
  });

  it('never constructs the lossy group sync endpoint', () => {
    const action = imageGrantAction({ type: 'group', id: 'g1' }, 'i1', 's2', false);
    expect(action.path).toBe('/admin/groups/g1/image-grants');
    expect(action.path).not.toContain('sync-servers');
  });
});
