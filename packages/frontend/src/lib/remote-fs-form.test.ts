import { describe, expect, it } from 'vitest';
import { createRemoteFsMountDraft } from './remote-fs-form.js';

describe('remote filesystem dialog drafts', () => {
  it('returns fresh create state and never retains a previous Ceph secret', () => {
    const first = createRemoteFsMountDraft();
    first.name = 'first';
    first.cephForm.secret = 'plaintext-secret';

    const reopened = createRemoteFsMountDraft();
    expect(reopened.name).toBe('');
    expect(reopened.cephForm.secret).toBe('');
    expect(reopened.cephForm).not.toBe(first.cephForm);
  });
});
