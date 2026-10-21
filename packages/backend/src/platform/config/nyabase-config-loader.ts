import { readFileSync } from 'fs';
import { createHash } from 'crypto';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_NYABASE_CONFIG_FILE,
  controlPlaneConfigDefinitions,
  type ConfigSourceName,
  type ControlPlaneConfigKey,
} from '@nyabase/common';

export interface ResolvedConfigField<T = unknown> {
  key: string;
  yamlPath: string;
  env: string;
  effectiveValue: T;
  source: ConfigSourceName;
  yamlValue: unknown;
  envValuePresent: boolean;
  defaultValue: T;
}

export type ResolvedConfigSnapshot = Record<ControlPlaneConfigKey, ResolvedConfigField>;

export interface LoadedNyabaseConfig {
  configFile: string;
  configFileIdentity: ConfigFileIdentity;
  revision: number;
  rawYaml: Record<string, unknown>;
  fields: ResolvedConfigSnapshot;
}

export interface ConfigFileIdentity {
  exists: boolean;
  sha256: string | null;
}

export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NYABASE_CONFIG_FILE?.trim() || DEFAULT_NYABASE_CONFIG_FILE;
}

function readConfigFile(path: string): { raw: string | null; identity: ConfigFileIdentity } {
  try {
    const raw = readFileSync(path, 'utf8');
    return {
      raw,
      identity: {
        exists: true,
        sha256: createHash('sha256').update(raw).digest('hex'),
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, identity: { exists: false, sha256: null } };
    }
    throw error;
  }
}

export function readConfigFileIdentity(path: string): ConfigFileIdentity {
  return readConfigFile(path).identity;
}

function parseYamlFile(path: string, raw: string | null): Record<string, unknown> {
  if (raw === null) return {};
  if (!raw.trim()) return {};
  const parsed = parseYaml(raw);
  if (parsed == null) return {};
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Config file ${path} must contain a YAML mapping`);
  }
  return parsed as Record<string, unknown>;
}

function getByPath(input: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = input;
  for (const segment of path.split('.')) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function formatZodError(key: string, source: ConfigSourceName, issues: { message: string }[]): string {
  const messages = issues.map((issue) => issue.message).join('; ');
  return `Invalid config ${key} from ${source}: ${messages}`;
}

export function loadNyabaseConfig(env: NodeJS.ProcessEnv = process.env): LoadedNyabaseConfig {
  const file = configFilePath(env);
  const loadedFile = readConfigFile(file);
  const rawYaml = parseYamlFile(file, loadedFile.raw);
  const revision = readControlPlaneRevision(rawYaml, file);
  const fields = {} as ResolvedConfigSnapshot;

  for (const definition of controlPlaneConfigDefinitions) {
    const yamlValue = getByPath(rawYaml, definition.yamlPath);
    const envValue = env[definition.env];
    const envValuePresent = envValue !== undefined && envValue !== '';
    const source: ConfigSourceName = envValuePresent
      ? 'env'
      : yamlValue !== undefined
        ? 'yaml'
        : 'default';
    const rawValue = source === 'env'
      ? envValue
      : source === 'yaml'
        ? yamlValue
        : definition.defaultValue;
    const parsed = definition.schema.safeParse(rawValue);
    if (!parsed.success) {
      throw new Error(formatZodError(definition.key, source, parsed.error.issues));
    }
    fields[definition.key] = {
      key: definition.key,
      yamlPath: definition.yamlPath,
      env: definition.env,
      effectiveValue: parsed.data,
      source,
      yamlValue,
      envValuePresent,
      defaultValue: definition.defaultValue,
    };
  }

  return {
    configFile: file,
    configFileIdentity: loadedFile.identity,
    revision,
    rawYaml,
    fields,
  };
}

function readControlPlaneRevision(rawYaml: Record<string, unknown>, file: string): number {
  const namespace = rawYaml.__nyabase;
  if (namespace === undefined) return 1;
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) {
    throw new Error(`Invalid config __nyabase namespace in ${file}`);
  }
  const revision = (namespace as Record<string, unknown>).revision;
  if (revision === undefined) return 1;
  if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
    throw new Error(`Invalid config __nyabase.revision in ${file}: expected a positive safe integer`);
  }
  return revision as number;
}
