import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function readSrc(relativeFromBackendSrc: string): string {
  return readFileSync(join(process.cwd(), 'src', relativeFromBackendSrc), 'utf8');
}

/**
 * Regression gate: user/admin privilege must not be selected via public
 * `admin` / `includeAll` boolean parameters on volume/container facades.
 */
describe('user/admin isolation API surface', () => {
  it('VolumesService exposes ForUser/ForAdmin without public includeAll/admin flags', () => {
    const src = readSrc('volumes/volumes.service.ts');
    expect(src).toMatch(/async listForUser\(/);
    expect(src).toMatch(/async listForAdmin\(/);
    expect(src).toMatch(/async listSharedForUser\(/);
    expect(src).toMatch(/async listSharedForAdmin\(/);
    expect(src).toMatch(/async createForUser\(/);
    expect(src).toMatch(/async createForAdmin\(/);
    expect(src).toMatch(/async createSharedForUser\(/);
    expect(src).toMatch(/async createSharedForAdmin\(/);
    expect(src).not.toMatch(/includeAll\s*=/);
    expect(src).not.toMatch(/async\s+\w+\([^)]*\badmin\s*=\s*false/);
    expect(src).not.toMatch(/async\s+\w+\([^)]*\bincludeAll\b/);
  });

  it('ContainerControlService create/limits/root/extension/listVolumes use ForUser/ForAdmin', () => {
    const src = readSrc('containers/container-control.service.ts');
    expect(src).toMatch(/async createForUser\(/);
    expect(src).toMatch(/async createForAdmin\(/);
    expect(src).toMatch(/async updateLimitsForUser\(/);
    expect(src).toMatch(/async updateLimitsForAdmin\(/);
    expect(src).toMatch(/async resizeRootForUser\(/);
    expect(src).toMatch(/async resizeRootForAdmin\(/);
    expect(src).toMatch(/async mutateExtensionForUser\(/);
    expect(src).toMatch(/async mutateExtensionForAdmin\(/);
    expect(src).toMatch(/async listVolumesForUser\(/);
    expect(src).toMatch(/async listVolumesForAdmin\(/);
    expect(src).not.toMatch(/async create\([\s\S]*?admin\s*=\s*false/);
    expect(src).not.toMatch(/async updateLimits\([\s\S]*?admin\s*=\s*false/);
    expect(src).not.toMatch(/async resizeRoot\([\s\S]*?admin\s*=\s*false/);
    expect(src).not.toMatch(/async mutateExtension\([\s\S]*?admin\s*=\s*false/);
    expect(src).not.toMatch(/async listVolumes\([\s\S]*?admin\s*=\s*false/);
  });

  it('controllers call matching facades only', () => {
    const volumesController = readSrc('volumes/volumes.controller.ts');
    expect(volumesController).toMatch(/listForUser/);
    expect(volumesController).toMatch(/createForAdmin/);
    expect(volumesController).not.toMatch(/createShared/);
    expect(volumesController).not.toMatch(/\.create\([^)]+,\s*true\s*\)/);
    expect(volumesController).not.toMatch(/\.list\([^)]+,\s*true\s*\)/);

    const sharedVolumesController = readSrc('volumes/shared-volumes.controller.ts');
    expect(sharedVolumesController).toMatch(/ManageSharedVolumes/);
    expect(sharedVolumesController).toMatch(/createSharedForAdmin/);
    expect(sharedVolumesController).toMatch(/listSharedForUser/);
    expect(sharedVolumesController).not.toMatch(/RequireCaps\(Capability\.ManageVolumes\)/);

    const adminContainers = readSrc('containers/admin-containers.controller.ts');
    expect(adminContainers).toMatch(/createForAdmin/);
    expect(adminContainers).not.toMatch(/\.create\([^)]+,\s*true\s*\)/);
    expect(adminContainers).not.toMatch(/listVolumes\([^)]+,\s*true\s*\)/);

    const userContainers = readSrc('containers/containers.controller.ts');
    expect(userContainers).toMatch(/createForUser/);
    expect(userContainers).toMatch(/updateLimitsForUser/);
  });
});
