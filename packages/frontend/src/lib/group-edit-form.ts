import { zUpdateGroupRequest, type UpdateGroupRequest } from '@nyabase/common';

export interface GroupEditFormState {
  name: string;
  description: string;
}

export interface GroupEditAuthority {
  canEditMetadata: boolean;
}

export type GroupEditPayloadResult =
  | { success: true; data: UpdateGroupRequest }
  | { success: false; error: string };

/** Build a least-authority PATCH. Untouched fields are never serialized. */
export function buildMinimalGroupEditPayload(
  form: GroupEditFormState,
  dirtyFields: ReadonlySet<keyof GroupEditFormState>,
  authority: GroupEditAuthority,
): GroupEditPayloadResult {
  if (dirtyFields.size > 0 && !authority.canEditMetadata) {
    return { success: false, error: '当前账号已无权修改用户组元数据' };
  }

  const payload: Record<string, unknown> = {};
  if (dirtyFields.has('name')) payload.name = form.name;
  if (dirtyFields.has('description')) payload.description = form.description || null;
  const parsed = zUpdateGroupRequest.safeParse(payload);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? '用户组字段无效' };
  }
  return { success: true, data: parsed.data };
}
