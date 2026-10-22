import { describe, expect, it } from 'vitest';
import {
  buildMinimalGroupEditPayload,
  type GroupEditFormState,
} from './group-edit-form.js';
import {
  createServerBackedDraft,
  editServerBackedDraft,
  mergeServerBackedDraft,
} from './server-backed-draft.js';

const form: GroupEditFormState = {
  name: 'Research',
  description: 'local description',
};

describe('minimal group edit payload', () => {
  it('sends only the dirty description', () => {
    expect(buildMinimalGroupEditPayload(form, new Set(['description']), {
      canEditMetadata: true,
    })).toEqual({ success: true, data: { description: 'local description' } });
  });

  it('rejects dirty fields whose authority shrank after the dialog opened', () => {
    expect(buildMinimalGroupEditPayload(form, new Set(['name']), {
      canEditMetadata: false,
    })).toMatchObject({ success: false });
  });

  it('merges concurrent untouched fields and flags same-field changes', () => {
    let draft = createServerBackedDraft(form);
    draft = editServerBackedDraft(draft, 'description', 'concurrent local description');
    draft = mergeServerBackedDraft(draft, { ...form, name: 'Renamed' });
    expect(draft.values).toMatchObject({
      name: 'Renamed',
      description: 'concurrent local description',
    });
    expect(draft.conflictFields.size).toBe(0);
    expect(buildMinimalGroupEditPayload(draft.values, draft.dirtyFields, {
      canEditMetadata: true,
    })).toEqual({ success: true, data: { description: 'concurrent local description' } });

    draft = editServerBackedDraft(draft, 'name', 'Mine');
    draft = mergeServerBackedDraft(draft, { ...draft.baseline, name: 'Theirs' });
    expect(draft.conflictFields).toEqual(new Set(['name']));
    expect(draft.values.name).toBe('Mine');
  });
});
