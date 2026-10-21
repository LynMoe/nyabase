import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(relativeFromBackendSrc: string): string {
  return readFileSync(join(process.cwd(), 'src', relativeFromBackendSrc), 'utf8');
}

/**
 * Regression gate: privilege is decided from the `Actor` the guard resolved,
 * never from a public `admin` / `includeAll` flag or a ForUser/ForAdmin pair.
 */
describe('actor-scoped API surface', () => {
  it('volume services take the actor first and expose no admin flags or wrappers', () => {
    const methods: Record<string, string[]> = {
      'volumes/local-volumes.service.ts': ['list', 'get', 'create', 'patch', 'delete', 'capacity'],
      'volumes/shared-volumes.service.ts': ['list', 'get', 'create', 'patch', 'delete'],
      'volumes/volume-attachments.service.ts': ['attach', 'detach'],
    };
    for (const [file, names] of Object.entries(methods)) {
      const src = readSrc(file);
      expect(src).not.toMatch(/For(User|Admin|System)\(/);
      expect(src).not.toMatch(/'user'\s*\|\s*'admin'/);
      for (const method of names) {
        expect(src).toMatch(new RegExp(`async ${method}\\(\\s*actor: Actor`));
      }
      expect(src).not.toMatch(/includeAll\s*=/);
      expect(src).not.toMatch(/async\s+\w+\([^)]*\badmin\s*=\s*false/);
      expect(src).not.toMatch(/async\s+\w+\([^)]*\bincludeAll\b/);
    }
  });

  it('ContainerControlService methods take the actor first and expose no admin flags or wrappers', () => {
    const src = readSrc('containers/container-control.service.ts');
    expect(src).not.toMatch(/For(User|Admin|System)\(/);
    for (const method of ['list', 'get', 'create', 'action', 'repairSsh', 'updateLimits',
      'resizeRoot', 'mutateGpus', 'listVolumes', 'listSharedVolumes', 'getStats',
      'createExecSession']) {
      expect(src).toMatch(new RegExp(`async ${method}\\(\\s*actor: Actor`));
    }
    expect(src).not.toMatch(/async create\([\s\S]*?admin\s*=\s*false/);
    expect(src).not.toMatch(/async updateLimits\([\s\S]*?admin\s*=\s*false/);
  });

  it('there is a single controller per resource and it resolves the actor', () => {
    for (const file of ['volumes/volumes.controller.ts', 'volumes/shared-volumes.controller.ts',
      'containers/containers.controller.ts', 'reconcile/intents.controller.ts']) {
      const src = readSrc(file);
      expect(src).toMatch(/@CurrentActor\(\)/);
      expect(src).not.toMatch(/@Controller\('admin\//);
      expect(src).not.toMatch(/\.(create|list)\([^)]+,\s*true\s*\)/);
    }
    expect(readSrc('volumes/shared-volumes.controller.ts')).toMatch(/ManageSharedVolumes/);
    expect(readSrc('volumes/shared-volumes.controller.ts'))
      .not.toMatch(/RequireCaps\(Capability\.ManageVolumes\)/);
  });
});
