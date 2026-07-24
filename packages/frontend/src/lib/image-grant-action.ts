export type ImageGrantSubject = { type: 'user' | 'group'; id: string };

export type ImageGrantAction = {
  method: 'POST' | 'DELETE';
  path: string;
  body?: { imageId: string; serverId: string };
};

/** Build a single-cell idempotent mutation; never derive a full replacement set. */
export function imageGrantAction(
  subject: ImageGrantSubject,
  imageId: string,
  serverId: string,
  currentlyGranted: boolean,
): ImageGrantAction {
  const subjectSegment = subject.type === 'user' ? 'users' : 'groups';
  const base = `/admin/${subjectSegment}/${subject.id}/image-grants`;
  if (currentlyGranted) {
    return { method: 'DELETE', path: `${base}/${imageId}/${serverId}` };
  }
  return { method: 'POST', path: base, body: { imageId, serverId } };
}
