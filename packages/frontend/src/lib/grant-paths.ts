/** Where a grant subject's grants live: users share the `/users` resource, groups stay under `/admin/groups`. */
export function grantSubjectPath(kind: 'users' | 'groups', subjectId: string): string {
  return kind === 'users' ? `/users/${subjectId}` : `/admin/groups/${subjectId}`;
}
