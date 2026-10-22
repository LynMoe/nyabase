/*
 * Request body shapes the agent forwards to Incus.
 *
 * Incus decodes with Go's encoding/json, which matches struct fields
 * case-insensitively ("Config" fills Config just like "config") and merges
 * duplicate object keys into the same map, while JSON.parse is case-sensitive
 * and keeps only the last duplicate. So the policy never forwards the bytes
 * it was given: every JSON body is parsed, each struct level must use only
 * the exact keys listed here (taken from what the Backend's IncusClient
 * sends), and the forwarded body is re-serialized from the checked object.
 * Map-typed fields (config, devices, a device's keys) are exact-match in Go
 * and are checked key by key by the policy itself.
 */

export type ValueCheck = (value: unknown) => boolean;

export const isString: ValueCheck = (value) => typeof value === 'string';
export const isBoolean: ValueCheck = (value) => typeof value === 'boolean';
export const isObject: ValueCheck = (value) => isRecord(value);
export const isArray: ValueCheck = (value) => Array.isArray(value);
const isEmptyArray: ValueCheck = (value) => Array.isArray(value) && value.length === 0;
const isCount: ValueCheck = (value) => Number.isSafeInteger(value) && (value as number) >= 0;
const isCommand: ValueCheck = (value) =>
  Array.isArray(value) && value.length > 0 && value.every((part) => typeof part === 'string');

export type FieldSchema = Readonly<Record<string, ValueCheck>>;

/** POST /1.0/instances (instance-spec.ts buildDesiredInstanceSpec, the preflight probe). */
export const INSTANCE_CREATE_FIELDS: FieldSchema = {
  name: isString,
  type: isString,
  profiles: isArray,
  source: isObject,
  config: isObject,
  devices: isObject,
  start: isBoolean,
};

/** InstancesPost.source: an image by fingerprint, optionally from a remote server. */
export const INSTANCE_SOURCE_FIELDS: FieldSchema = {
  type: isString,
  fingerprint: isString,
  alias: isString,
  server: isString,
  protocol: isString,
  project: isString,
};

/** PUT / PATCH /1.0/instances/{name} (IncusClient.readModifyWriteInstance). */
export const INSTANCE_UPDATE_FIELDS: FieldSchema = {
  architecture: isString,
  config: isObject,
  description: isString,
  devices: isObject,
  ephemeral: isBoolean,
  profiles: isArray,
  stateful: isBoolean,
};

/** POST /1.0/instances/{name}: rename only. */
export const INSTANCE_RENAME_FIELDS: FieldSchema = { name: isString };

/** PUT /1.0/instances/{name}/state. */
export const INSTANCE_STATE_FIELDS: FieldSchema = { action: isString, force: isBoolean };

/** POST /1.0/instances/{name}/exec (guest network, sshd probe, preflight, console). */
export const INSTANCE_EXEC_FIELDS: FieldSchema = {
  command: isCommand,
  'record-output': isBoolean,
  interactive: isBoolean,
  'wait-for-websocket': isBoolean,
  width: isCount,
  height: isCount,
  user: isCount,
  group: isCount,
};

/** POST /1.0/storage-pools/{pool}/volumes (volume-ops.ts createCustomVolume). */
export const VOLUME_CREATE_FIELDS: FieldSchema = {
  name: isString,
  type: isString,
  content_type: isString,
  config: isObject,
};

/** PUT / PATCH of a custom volume (volume-ops.ts updateCustomVolume). */
export const VOLUME_UPDATE_FIELDS: FieldSchema = { config: isObject, description: isString };

/** POST /1.0/images: a pull from a remote image server (image-assignment-ops.ts ensurePulled). */
export const IMAGE_PULL_FIELDS: FieldSchema = { aliases: isEmptyArray, source: isObject };

export const IMAGE_SOURCE_FIELDS: FieldSchema = {
  type: isString,
  alias: isString,
  fingerprint: isString,
  protocol: isString,
  server: isString,
  image_type: isString,
};

/** POST /1.0/images/aliases (image-assignment-ops.ts). */
export const IMAGE_ALIAS_FIELDS: FieldSchema = { name: isString, target: isString, type: isString };

/**
 * Why `record` does not match `schema`, or undefined when every key is listed
 * (exactly, so no case variant can alias a Go struct field) and holds a value
 * of the listed shape.
 */
export function fieldsProblem(
  record: Record<string, unknown>,
  schema: FieldSchema,
  label: string,
): string | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (!Object.hasOwn(schema, key)) return `${label} field ${JSON.stringify(key)} is not allowed`;
    if (!schema[key]!(value)) return `${label} field ${key} is malformed`;
  }
  return undefined;
}

/** A JSON object body, or undefined when it is absent, malformed or not an object. */
export function jsonBody(body: Buffer | undefined): Record<string, unknown> | undefined {
  if (!body || body.byteLength === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The body actually forwarded: the checked object, re-serialized. */
export function serialize(body: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(body));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
