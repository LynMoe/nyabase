export interface ServerBackedDraft<T extends object> {
  baseline: T;
  values: T;
  dirtyFields: ReadonlySet<keyof T>;
  conflictFields: ReadonlySet<keyof T>;
}

/** A CAS revision that belongs to exactly the same server baseline as the
 * draft. Components must submit this revision, never a live query prop whose
 * merge effect may not have run yet. */
export interface RevisionedServerBackedDraft<T extends object> extends ServerBackedDraft<T> {
  revision: number;
  snapshotToken: string | null;
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length
      && left.every((value, index) => Object.is(value, right[index]));
  }
  return Object.is(left, right);
}

export function createServerBackedDraft<T extends object>(
  serverValues: T,
): ServerBackedDraft<T> {
  return {
    baseline: { ...serverValues },
    values: { ...serverValues },
    dirtyFields: new Set(),
    conflictFields: new Set(),
  };
}

export function createRevisionedServerBackedDraft<T extends object>(
  serverValues: T,
  revision: number,
  snapshotToken: string | null = null,
): RevisionedServerBackedDraft<T> {
  return { ...createServerBackedDraft(serverValues), revision, snapshotToken };
}

export function editServerBackedDraft<T extends object, K extends keyof T>(
  draft: ServerBackedDraft<T>,
  field: K,
  value: T[K],
): ServerBackedDraft<T> {
  const values = { ...draft.values, [field]: value };
  const dirtyFields = new Set(draft.dirtyFields);
  const conflictFields = new Set(draft.conflictFields);
  if (sameValue(value, draft.baseline[field])) {
    dirtyFields.delete(field);
    conflictFields.delete(field);
  } else {
    dirtyFields.add(field);
  }
  return { ...draft, values, dirtyFields, conflictFields };
}

export function editRevisionedServerBackedDraft<T extends object, K extends keyof T>(
  draft: RevisionedServerBackedDraft<T>,
  field: K,
  value: T[K],
): RevisionedServerBackedDraft<T> {
  return {
    ...editServerBackedDraft(draft, field, value),
    revision: draft.revision,
    snapshotToken: draft.snapshotToken,
  };
}

/**
 * Three-way merge a new server snapshot. Untouched fields advance normally;
 * local edits survive, and simultaneous same-field changes are made explicit.
 */
export function mergeServerBackedDraft<T extends object>(
  draft: ServerBackedDraft<T>,
  incoming: T,
): ServerBackedDraft<T> {
  const baseline = { ...incoming };
  const values = { ...draft.values };
  const dirtyFields = new Set<keyof T>();
  const conflictFields = new Set<keyof T>();
  const keys = new Set<keyof T>([
    ...(Object.keys(draft.baseline) as Array<keyof T>),
    ...(Object.keys(incoming) as Array<keyof T>),
  ]);

  for (const field of keys) {
    const wasDirty = draft.dirtyFields.has(field);
    const wasConflicted = draft.conflictFields.has(field);
    const serverChanged = !sameValue(incoming[field], draft.baseline[field]);
    if (!wasDirty) values[field] = incoming[field];
    if (sameValue(values[field], incoming[field])) continue;
    dirtyFields.add(field);
    if (wasDirty && (serverChanged || wasConflicted)) conflictFields.add(field);
  }

  return { baseline, values, dirtyFields, conflictFields };
}

export function mergeRevisionedServerBackedDraft<T extends object>(
  draft: RevisionedServerBackedDraft<T>,
  incoming: T,
  incomingRevision: number,
  incomingSnapshotToken: string | null = draft.snapshotToken,
): RevisionedServerBackedDraft<T> {
  if (incomingRevision < draft.revision) return draft;
  return {
    ...mergeServerBackedDraft(draft, incoming),
    revision: incomingRevision,
    snapshotToken: incomingSnapshotToken,
  };
}

/** Merge a server snapshot carried by the rejection of this draft's own CAS
 * write. Unlike an asynchronously cached query result, that `current` value is
 * authoritative for the failed admission even if a legacy server reports a
 * lower revision. */
export function mergeAuthoritativeRevisionedServerBackedDraft<T extends object>(
  draft: RevisionedServerBackedDraft<T>,
  incoming: T,
  incomingRevision: number,
  incomingSnapshotToken: string | null = draft.snapshotToken,
): RevisionedServerBackedDraft<T> {
  return {
    ...mergeServerBackedDraft(draft, incoming),
    revision: incomingRevision,
    snapshotToken: incomingSnapshotToken,
  };
}

export function resolveDraftConflicts<T extends object>(
  draft: ServerBackedDraft<T>,
  resolution: 'keep-local' | 'use-server',
): ServerBackedDraft<T> {
  if (draft.conflictFields.size === 0) return draft;
  if (resolution === 'keep-local') {
    return { ...draft, conflictFields: new Set() };
  }
  let next = draft;
  for (const field of draft.conflictFields) {
    next = editServerBackedDraft(next, field, draft.baseline[field]);
  }
  return { ...next, conflictFields: new Set() };
}

export function resolveRevisionedDraftConflicts<T extends object>(
  draft: RevisionedServerBackedDraft<T>,
  resolution: 'keep-local' | 'use-server',
): RevisionedServerBackedDraft<T> {
  return {
    ...resolveDraftConflicts(draft, resolution),
    revision: draft.revision,
    snapshotToken: draft.snapshotToken,
  };
}
