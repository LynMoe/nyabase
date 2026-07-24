import { getControlPlaneConfigDefinition, type SystemSettingFieldDto } from '@nyabase/common';

export type ParsedSettingDraft =
  | { success: true; value: unknown }
  | { success: false; error: string };

export function parseSystemSettingDraft(field: SystemSettingFieldDto, text: string): ParsedSettingDraft {
  const definition = getControlPlaneConfigDefinition(field.key);
  if (!definition) return { success: false, error: '未知配置项' };
  if (field.valueKind === 'number' && text.trim() === '') {
    return { success: false, error: '数值不能为空' };
  }
  const candidate = field.valueKind === 'number'
    ? Number(text)
    : field.valueKind === 'boolean'
      ? text === 'true'
      : text;
  if (field.valueKind === 'number' && !Number.isFinite(candidate)) {
    return { success: false, error: '请输入有效数值' };
  }
  const parsed = definition.schema.safeParse(candidate);
  if (!parsed.success) {
    return { success: false, error: parsed.error.issues[0]?.message ?? '配置值无效' };
  }
  return { success: true, value: parsed.data };
}
