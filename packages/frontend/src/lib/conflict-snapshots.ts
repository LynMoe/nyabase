import {
  type SystemSettingFieldDto,
  type SystemSettingsDto,
} from '@nyabase/common';

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isSystemSettingField(value: unknown): value is SystemSettingFieldDto {
  const field = record(value);
  return Boolean(field
    && typeof field.key === 'string'
    && typeof field.yamlPath === 'string'
    && typeof field.env === 'string'
    && typeof field.valueKind === 'string'
    && typeof field.source === 'string'
    && typeof field.envValuePresent === 'boolean'
    && typeof field.secret === 'boolean'
    && typeof field.editable === 'boolean'
    && typeof field.restartRequired === 'boolean'
    && typeof field.public === 'boolean'
    && typeof field.label === 'string'
    && typeof field.description === 'string');
}

export function isSystemSettingsDto(value: unknown): value is SystemSettingsDto {
  const dto = record(value);
  return Boolean(dto
    && positiveRevision(dto.revision)
    && typeof dto.configFile === 'string'
    && Array.isArray(dto.fields) && dto.fields.every(isSystemSettingField)
    && Array.isArray(dto.editable) && dto.editable.every(isSystemSettingField)
    && Array.isArray(dto.readOnly) && dto.readOnly.every(isSystemSettingField)
    && record(dto.publicSettings));
}
