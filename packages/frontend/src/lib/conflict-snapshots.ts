import {
  Capability,
  type AdminImageDto,
  type GroupDto,
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
    && typeof dto.snapshotToken === 'string'
    && dto.snapshotToken.length > 0
    && typeof dto.configFile === 'string'
    && Array.isArray(dto.fields) && dto.fields.every(isSystemSettingField)
    && Array.isArray(dto.editable) && dto.editable.every(isSystemSettingField)
    && Array.isArray(dto.readOnly) && dto.readOnly.every(isSystemSettingField)
    && record(dto.publicSettings));
}

function isRuntimeArgs(value: unknown): value is string[] | null {
  return value === null || (Array.isArray(value) && value.every((item) => typeof item === 'string'));
}

export function isAdminImageDto(value: unknown): value is AdminImageDto {
  const dto = record(value);
  const runtime = record(dto?.runtimeOverrides);
  return Boolean(dto && runtime
    && typeof dto.id === 'string'
    && typeof dto.name === 'string'
    && typeof dto.dockerImage === 'string'
    && positiveRevision(dto.revision)
    && Number.isInteger(runtime.uid) && (runtime.uid as number) >= 0
    && isRuntimeArgs(runtime.entrypoint)
    && isRuntimeArgs(runtime.cmd)
    && typeof runtime.init === 'boolean'
    && (dto.description === null || typeof dto.description === 'string')
    && typeof dto.isActive === 'boolean'
    && typeof dto.disableSsh === 'boolean'
    && typeof dto.deleting === 'boolean'
    && Number.isInteger(dto.cleanupGeneration)
    && typeof dto.createdAt === 'string'
    && typeof dto.updatedAt === 'string');
}

const CAPABILITIES = new Set<string>(Object.values(Capability));

export function isGroupDto(value: unknown): value is GroupDto {
  const dto = record(value);
  return Boolean(dto
    && typeof dto.id === 'string'
    && typeof dto.name === 'string'
    && (dto.description === null || typeof dto.description === 'string')
    && Number.isInteger(dto.priority) && (dto.priority as number) >= 0
    && typeof dto.isSystem === 'boolean'
    && Array.isArray(dto.capabilities)
    && dto.capabilities.every((capability) => typeof capability === 'string' && CAPABILITIES.has(capability))
    && positiveRevision(dto.revision)
    && typeof dto.createdAt === 'string'
    && typeof dto.updatedAt === 'string');
}
