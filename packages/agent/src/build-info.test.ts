import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentBuild } from './build-info.js';

const roots: string[] = [];

function root(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'nyabase-agent-build-'));
  roots.push(dir);
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value));
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('agent build info', () => {
  it('reports the bundle version and commit', () => {
    const dir = root({
      'package.json': { version: '0.1.0' },
      'build-info.json': { version: '0.1.0+gdd2556a05335', commit: 'dd2556a0533a88788da5c92654ad76dc947922d5' },
    });
    expect(readAgentBuild(dir)).toEqual({
      version: '0.1.0+gdd2556a05335',
      commit: 'dd2556a0533a88788da5c92654ad76dc947922d5',
    });
  });

  it('says an unbundled build is unbundled', () => {
    expect(readAgentBuild(root({ 'package.json': { version: '0.1.0' } }))).toEqual({
      version: '0.1.0+unbundled',
      commit: null,
    });
  });
});
