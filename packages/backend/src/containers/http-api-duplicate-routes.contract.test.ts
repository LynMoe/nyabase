import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function joinPath(prefix: string, path: string): string {
  const left = String(prefix ?? '').replace(/^\/+|\/+$/g, '');
  const right = String(path ?? '').replace(/^\/+|\/+$/g, '');
  if (!right) return left;
  if (!left) return right;
  return `${left}/${right}`;
}

function normalizePattern(path: string): string {
  return path.replace(/:(id|serverId|containerId)(?=\/|$)/g, ':param');
}

function asList(value: unknown): string[] {
  if (value == null) return [''];
  return (Array.isArray(value) ? value : [value]).map((item) => String(item));
}

function asMethods(value: unknown): number[] {
  if (value == null) return [];
  return (Array.isArray(value) ? value : [value]).map((item) => Number(item));
}

describe('HTTP API route uniqueness', () => {
  it('does not declare the same METHOD+path-pattern on two controllers', async () => {
    const srcRoot = join(process.cwd(), 'src');
    const files = readdirSync(srcRoot, { recursive: true, encoding: 'utf8' })
      .filter((name) => name.endsWith('.controller.ts') && !name.endsWith('.test.ts'));
    const declared = new Map<string, string[]>();

    for (const file of files) {
      const module = await import(pathToFileURL(join(srcRoot, file)).href) as Record<string, unknown>;
      for (const [exportName, value] of Object.entries(module)) {
        if (typeof value !== 'function') continue;
        const prefixMeta = Reflect.getMetadata(PATH_METADATA, value);
        if (prefixMeta === undefined) continue;
        const prefixes = asList(prefixMeta);
        const proto = (value as { prototype?: object }).prototype;
        if (!proto) continue;
        for (const methodName of Object.getOwnPropertyNames(proto)) {
          if (methodName === 'constructor') continue;
          const handler = (proto as Record<string, unknown>)[methodName];
          if (typeof handler !== 'function') continue;
          const methods = asMethods(Reflect.getMetadata(METHOD_METADATA, handler));
          if (methods.length === 0) continue;
          const paths = asList(Reflect.getMetadata(PATH_METADATA, handler));
          for (const prefix of prefixes) {
            for (const path of paths) {
              const pattern = normalizePattern(joinPath(prefix, path));
              for (const method of methods) {
                const key = `${METHOD_NAMES[method] ?? method} ${pattern}`;
                const owners = declared.get(key) ?? [];
                owners.push(`${file}:${exportName}.${methodName}`);
                declared.set(key, owners);
              }
            }
          }
        }
      }
    }

    const duplicates = [...declared.entries()]
      .filter(([, owners]) => new Set(owners).size > 1)
      .map(([key, owners]) => `${key} -> ${[...new Set(owners)].join(', ')}`);

    expect(duplicates).toEqual([]);
  });
});
