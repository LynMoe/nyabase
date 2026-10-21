import {
  zUpdateGroupRequest,
  type Capability,
  type UpdateGroupRequest,
} from '@nyabase/common';

export interface GroupEditFormState {
  name: string;
  description: string;
  capabilities: Capability[];
}

export interface GroupEditAuthority {
  isSystem: boolean;
  canEditMetadata: boolean;
}

export type GroupEditPayloadResult =
  | { success: true; data: UpdateGroupRequest }
  | { success: false; error: string };

/** Build a least-authority PATCH. Disabled and untouched fields are never
 * serialized, including capabilities left over from an older view. */
export function buildMinimalGroupEditPayload(
  form: GroupEditFormState,
  dirtyFields: ReadonlySet<keyof GroupEditFormState>,
  authority: GroupEditAuthority,
): GroupEditPayloadResult {
  const metadataFields: Array<keyof GroupEditFormState> = ['name', 'description', 'capabilities'];
  if (metadataFields.some((field) => dirtyFields.has(field)) && !authority.canEditMetadata) {
    return { success: false, error: '当前账号已无权修改用户组元数据' };
  }
  if (authority.isSystem
    && (dirtyFields.has('name') || dirtyFields.has('capabilities'))) {
    return { success: false, error: '内置用户组仅允许修改描述' };
  }

  const payload: Record<string, unknown> = {};
  if (!authority.isSystem && dirtyFields.has('name')) payload.name = form.name;
  if (dirtyFields.has('description')) payload.description = form.description || null;
  if (!authority.isSystem && dirtyFields.has('capabilities')) {
    payload.capabilities = [...form.capabilities];
  }
  const parsed = zUpdateGroupRequest.safeParse(payload);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? '用户组字段无效' };
  }
  return { success: true, data: parsed.data };
}
