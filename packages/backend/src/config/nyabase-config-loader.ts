import { existsSync, readFileSync } from 'fs';
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
  rawYaml: Record<string, unknown>;
  fields: ResolvedConfigSnapshot;
}

function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NYABASE_CONFIG_FILE?.trim() || DEFAULT_NYABASE_CONFIG_FILE;
}

function readYamlFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, 'utf8');
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
  const rawYaml = readYamlFile(file);
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

  return { configFile: file, rawYaml, fields };
}
