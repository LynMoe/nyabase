import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readSource } from './read-source.test-helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');

function readPage(name: string): string {
  return readSource(srcRoot, `pages/${name}`);
}

function readSrc(rel: string): string {
  return readSource(srcRoot, rel);
}

describe('user panel pages stay on scope=mine', () => {
  it('volumes-page never calls /admin/*, scope=all or the ManageVolumes switch', () => {
    const src = readPage('volumes-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/scope=all/);
    expect(src).not.toMatch(/ManageVolumes/);
    expect(src).toMatch(/api\.get<VolumeDto\[\]>\('\/volumes'\)/);
    expect(src).not.toMatch(/ownerId/);
  });

  it('server-storage-tab stays on scope=all volumes', () => {
    const src = readSrc('components/servers/server-storage-tab.tsx');
    expect(src).toMatch(/api\.get<VolumeDto\[\]>\(`\/volumes\?scope=all&serverId=\$\{/);
    expect(src).not.toMatch(/api\.get<VolumeDto\[\]>\('\/volumes'\)/);
    expect(src).not.toMatch(/新建数据卷/);
    expect(src).not.toMatch(/api\.post/);
  });

  it('local-volume-table links attached containers on its own scope', () => {
    const src = readSrc('components/storage/local-volume-table.tsx');
    const list = readSrc('components/storage/volume-attachment-list.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    // The table never picks a container route itself; ResourceRef does, from the scope.
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/<VolumeAttachmentList attachments=\{volume\.attachments\} scope=\{scope\}/);
    expect(list).toMatch(/kind="container"[^>]*scope=\{scope\}/);
    expect(src).toMatch(/resourceIntentsPath\(scope, IntentResourceType\.Volume, volume\.id\)/);
  });

  it('only the scope=all volume views can delete a volume, through one dialog', () => {
    const dialog = readSrc('components/storage/delete-volume-dialog.tsx');
    expect(dialog).toMatch(/api\.delete<IntentAcceptedDto>\(/);
    expect(dialog).toMatch(/`\/volumes\/\$\{volume\.id\}`/);
    expect(dialog).toMatch(/`\/shared-volumes\/\$\{volume\.id\}`/);
    expect(dialog).toMatch(/无法恢复/);
    for (const admin of [
      readPage('manage-volumes-page.tsx'),
      readSrc('components/servers/server-storage-tab.tsx'),
      readPage('shared-backend-detail-page.tsx'),
    ]) {
      expect(admin).toMatch(/DeleteVolumeDialog/);
      expect(admin).toMatch(/scope="all"/);
    }
    for (const mine of [readPage('volumes-page.tsx'), readPage('shared-volumes-page.tsx')]) {
      expect(mine).not.toMatch(/DeleteVolumeDialog|onDelete=/);
    }
  });

  it('manage-containers-page lists and operates without admin create', () => {
    const src = readPage('manage-containers-page.tsx');
    expect(src).toMatch(/api\.get<ContainerDto\[\]>\('\/containers\?scope=all'\)/);
    expect(src).not.toMatch(/代建/);
    expect(src).not.toMatch(/AdminCreateContainerDialog/);
    expect(src).not.toMatch(/api\.post<IntentAcceptedDto>\('\/containers'/);
  });

  it('shared-volumes-page never calls /admin/* or scope=all', () => {
    const src = readPage('shared-volumes-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/scope=all/);
    expect(src).toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(src).not.toMatch(/ownerId/);
  });

  it('shared-backends-page stays on scope=all shared-volumes', () => {
    const list = readPage('shared-backends-page.tsx');
    const detail = readPage('shared-backend-detail-page.tsx');
    expect(list).not.toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(detail).toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes\?scope=all'\)/);
    expect(detail).not.toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(detail).toMatch(/SharedVolumeCatalogInspectDialog/);
    expect(detail).toMatch(/enabled: canManageVolumes,/);
  });

  it('container list usage reads the scoped usage API, never /admin/performance', () => {
    const hook = readSrc('hooks/use-container-live-usage.ts');
    expect(hook).toMatch(/scopedPath\('\/performance\/usage', scope\)/);
    expect(hook).toMatch(/useHasRole\(Role\.UserAdmin\)/);
    expect(hook).not.toMatch(/\/admin\/performance/);
    const table = readSrc('components/containers/container-table.tsx');
    expect(table).toMatch(/useContainerLiveUsage\(admin \? 'all' : 'mine'\)/);
    const dashboard = readPage('dashboard-page.tsx');
    expect(dashboard).not.toMatch(/\/admin\/performance|scope=all/);
    expect(dashboard).not.toMatch(/PerformancePanel/);
  });

  it('servers page mounts the scope=all performance view', () => {
    const src = readPage('servers-page.tsx');
    expect(src).toMatch(/\/performance\/usage\?scope=all'/);
    expect(src).toMatch(/useHasRole\(Role\.Admin\)/);
    expect(src).not.toMatch(/PerformancePanel/);
  });

  it('dashboard-page never calls /admin/* or capability plane switch', () => {
    const src = readPage('dashboard-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ViewMetricsAll/);
    expect(src).not.toMatch(/ManageContainersAny/);
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/to="\/containers"/);
  });

  it('quota summary never calls /admin/* and stays on user grant APIs', () => {
    const src = readSrc('components/quota/quota-summary.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ManageContainersAny/);
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/api\.get<EffectiveAccessDto>\('\/me\/access'\)/);
    expect(src).toMatch(/api\.get<UserServerDto\[\]>\('\/servers'\)/);
    expect(src).toMatch(/api\.get<ContainerDto\[\]>\('\/containers'\)/);
    expect(src).toMatch(/api\.get<SharedBackendDto\[\]>\('\/shared-backends'\)/);
    // The access DTO carries what the system disks hold: no capacity call per server.
    expect(src).toMatch(/rootDiskCommittedBytes/);
  });

  it('http-proxy-page never calls /admin/* and stays on user HTTP 发布 APIs', () => {
    const src = readPage('http-proxy-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ManageSystemSettings/);
    expect(src).toMatch(/api\.get<HttpProxyBindingDto\[\]>\('\/http-proxy\/bindings'\)/);
    expect(src).toMatch(/api\.get<HttpDomainPoolPublicDto\[\]>\('\/http-proxy\/domain-pools'\)/);
    expect(src).toMatch(/api\.get<ContainerDto\[\]>\('\/containers'\)/);
  });
});
