import { describe, expect, it } from 'vitest';
import {
  createServerBackedDraft,
  createRevisionedServerBackedDraft,
  editServerBackedDraft,
  editRevisionedServerBackedDraft,
  mergeServerBackedDraft,
  mergeAuthoritativeRevisionedServerBackedDraft,
  mergeRevisionedServerBackedDraft,
  resolveDraftConflicts,
} from './server-backed-draft.js';

describe('server-backed draft', () => {
  it('merges untouched server fields without replacing a dirty field', () => {
    let draft = createServerBackedDraft({ name: 'old', description: 'before' });
    draft = editServerBackedDraft(draft, 'name', 'local');
    draft = mergeServerBackedDraft(draft, { name: 'old', description: 'remote' });
    expect(draft.values).toEqual({ name: 'local', description: 'remote' });
    expect([...draft.dirtyFields]).toEqual(['name']);
    expect(draft.conflictFields.size).toBe(0);
  });

  it('marks simultaneous same-field changes and never drops local input', () => {
    let draft = createServerBackedDraft({ name: 'old', description: 'before' });
    draft = editServerBackedDraft(draft, 'name', 'local');
    draft = mergeServerBackedDraft(draft, { name: 'remote', description: 'before' });
    expect(draft.values.name).toBe('local');
    expect([...draft.conflictFields]).toEqual(['name']);

    draft = mergeServerBackedDraft(draft, { name: 'remote', description: 'before' });
    expect([...draft.conflictFields]).toEqual(['name']);

    const keep = resolveDraftConflicts(draft, 'keep-local');
    expect(keep.values.name).toBe('local');
    expect(keep.conflictFields.size).toBe(0);

    const useServer = resolveDraftConflicts(draft, 'use-server');
    expect(useServer.values.name).toBe('remote');
    expect(useServer.dirtyFields.size).toBe(0);
  });

  it('treats a server value equal to the local edit as resolved', () => {
    let draft = createServerBackedDraft({ name: 'old' });
    draft = editServerBackedDraft(draft, 'name', 'same');
    draft = mergeServerBackedDraft(draft, { name: 'same' });
    expect(draft.dirtyFields.size).toBe(0);
    expect(draft.conflictFields.size).toBe(0);
  });

  it('compares primitive arrays structurally across refreshed snapshots', () => {
    let draft = createServerBackedDraft({ tags: ['a'], description: 'old' });
    draft = editServerBackedDraft(draft, 'description', 'local');
    draft = mergeServerBackedDraft(draft, { tags: ['a'], description: 'old' });
    expect(draft.dirtyFields).toEqual(new Set(['description']));
    expect(draft.conflictFields.size).toBe(0);

    draft = editServerBackedDraft(draft, 'tags', ['a', 'b']);
    draft = mergeServerBackedDraft(draft, { tags: ['a', 'c'], description: 'old' });
    expect(draft.values.tags).toEqual(['a', 'b']);
    expect(draft.conflictFields).toEqual(new Set(['tags']));
  });

  it('keeps a settings save on R1 until the R2 values and revision merge atomically', () => {
    let draft = createRevisionedServerBackedDraft(
      { title: 'R1', description: 'before' }, 1,
    );
    draft = editRevisionedServerBackedDraft(draft, 'title', 'local');

    // React has rendered an R2 query prop, but its merge effect has not run.
    // The only safe submission revision remains the one bound to this R1 draft.
    expect({
      values: draft.values,
      expectedRevision: draft.revision,
    }).toEqual({
      values: { title: 'local', description: 'before' },
      expectedRevision: 1,
    });

    draft = mergeRevisionedServerBackedDraft(
      draft,
      { title: 'R1', description: 'R2 remote' },
      2,
    );
    expect(draft).toMatchObject({
      values: { title: 'local', description: 'R2 remote' },
      revision: 2,
    });
  });

  it('accepts a validated conflict response as authoritative even if its revision is lower', () => {
    let draft = createRevisionedServerBackedDraft({ name: 'R2', description: 'before' }, 2);
    draft = editRevisionedServerBackedDraft(draft, 'description', 'local');
    draft = mergeAuthoritativeRevisionedServerBackedDraft(
      draft,
      { name: 'externally replaced', description: 'remote' },
      1,
    );
    expect(draft).toMatchObject({
      revision: 1,
      values: { name: 'externally replaced', description: 'local' },
    });
    expect(draft.conflictFields).toEqual(new Set(['description']));
  });
});
