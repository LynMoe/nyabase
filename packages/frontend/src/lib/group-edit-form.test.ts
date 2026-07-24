import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
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
  name: 'Operators',
  description: 'local description',
  priority: '50',
  capabilities: [Capability.ManageGroups],
};

describe('minimal group edit payload', () => {
  it('never sends untouched priority or capabilities with a metadata-only edit', () => {
    expect(buildMinimalGroupEditPayload(form, new Set(['description']), {
      isSystem: false,
      canEditMetadata: true,
      canEditPriority: false,
    })).toEqual({ success: true, data: { description: 'local description' } });
  });

  it('rejects dirty fields whose authority shrank after the dialog opened', () => {
    expect(buildMinimalGroupEditPayload(form, new Set(['priority']), {
      isSystem: false,
      canEditMetadata: true,
      canEditPriority: false,
    })).toMatchObject({ success: false });
    expect(buildMinimalGroupEditPayload(form, new Set(['capabilities']), {
      isSystem: false,
      canEditMetadata: false,
      canEditPriority: true,
    })).toMatchObject({ success: false });
  });

  it('allows only a dirty description for system groups', () => {
    expect(buildMinimalGroupEditPayload(form, new Set(['description']), {
      isSystem: true,
      canEditMetadata: true,
      canEditPriority: false,
    })).toEqual({ success: true, data: { description: 'local description' } });
    expect(buildMinimalGroupEditPayload(form, new Set(['name']), {
      isSystem: true,
      canEditMetadata: true,
      canEditPriority: false,
    })).toMatchObject({ success: false });
  });

  it('submits the full explicitly-dirty dominance-sensitive set when authorized', () => {
    expect(buildMinimalGroupEditPayload(form, new Set(['priority', 'capabilities']), {
      isSystem: false,
      canEditMetadata: true,
      canEditPriority: true,
    })).toEqual({
      success: true,
      data: { priority: 50, capabilities: [Capability.ManageGroups] },
    });
  });

  it('merges concurrent untouched dominance fields and flags same-field capability changes', () => {
    let draft = createServerBackedDraft(form);
    draft = editServerBackedDraft(draft, 'description', 'concurrent local description');
    draft = mergeServerBackedDraft(draft, {
      ...form,
      priority: '75',
      capabilities: [Capability.ManageGroups, Capability.ViewAudit],
    });
    expect(draft.values).toMatchObject({
      description: 'concurrent local description',
      priority: '75',
      capabilities: [Capability.ManageGroups, Capability.ViewAudit],
    });
    expect(draft.conflictFields.size).toBe(0);
    expect(buildMinimalGroupEditPayload(draft.values, draft.dirtyFields, {
      isSystem: false,
      canEditMetadata: true,
      canEditPriority: true,
    })).toEqual({ success: true, data: { description: 'concurrent local description' } });

    draft = editServerBackedDraft(draft, 'capabilities', [Capability.ManageUsers]);
    draft = mergeServerBackedDraft(draft, {
      ...draft.baseline,
      capabilities: [Capability.ManageGroups],
    });
    expect(draft.conflictFields).toEqual(new Set(['capabilities']));
    expect(draft.values.capabilities).toEqual([Capability.ManageUsers]);
  });
});
