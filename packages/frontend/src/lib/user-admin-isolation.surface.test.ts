import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(here, '..');
const pages = join(srcRoot, 'pages');

function readPage(name: string): string {
  return readFileSync(join(pages, name), 'utf8');
}

function readSrc(rel: string): string {
  return readFileSync(join(srcRoot, rel), 'utf8');
}

function assertAdminPlaneOnly(src: string, pattern: RegExp) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = [...src.matchAll(global)];
  expect(matches.length).toBeGreaterThan(0);
  for (const match of matches) {
    const start = match.index ?? 0;
    const window = src.slice(Math.max(0, start - 280), start);
    const last = [...window.matchAll(/plane === '(admin|user)'/g)].pop();
    expect(last?.[1], `${match[0]} must sit in plane === 'admin'`).toBe('admin');
  }
}

describe('user panel pages stay on user API plane', () => {
  it('volumes-page never calls /admin/* or ManageVolumes plane switch', () => {
    const src = readPage('volumes-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ManageVolumes/);
    expect(src).toMatch(/api\.get<VolumeDto\[\]>\('\/volumes'\)/);
    expect(src).not.toMatch(/ownerId/);
  });

  it('server-storage-tab stays on admin volumes API', () => {
    const src = readSrc('components/servers/server-storage-tab.tsx');
    expect(src).toMatch(/api\.get<VolumeDto\[\]>\(`\/admin\/volumes\?serverId=\$\{/);
    expect(src).not.toMatch(/api\.get<VolumeDto\[\]>\('\/volumes'\)/);
    expect(src).not.toMatch(/新建数据卷/);
    expect(src).not.toMatch(/api\.post/);
  });

  it('local-volume-table gates admin URLs behind plane === admin', () => {
    const src = [
      readSrc('components/storage/local-volume-table.tsx'),
      readSrc('components/storage/local-volume-detail-dialog.tsx'),
    ].join('\n');
    assertAdminPlaneOnly(src, /\/admin\//);
    assertAdminPlaneOnly(src, /\/manage\/containers/);
    expect(src).toMatch(/plane === 'user'/);
    expect(src).toMatch(/\/volumes\/\$\{volume\.id\}\/intents/);
    expect(src).toMatch(/to="\/containers"/);
  });

  it('local-volume-form-dialog gates /admin/volumes behind plane === admin', () => {
    const src = readSrc('components/storage/local-volume-form-dialog.tsx');
    assertAdminPlaneOnly(src, /\/admin\/volumes/);
    expect(src).not.toMatch(/api\.post<unknown>\('\/admin\/volumes'/);
    expect(src).toMatch(/api\.patch<IntentAcceptedDto \| VolumeDto>\(volumeItemPath/);
    expect(src).not.toMatch(/ownerId/);
    expect(src).not.toMatch(/所有者 UUID/);
  });

  it('manage-containers-page lists and operates without admin create', () => {
    const src = readPage('manage-containers-page.tsx');
    expect(src).toMatch(/api\.get<ContainerDto\[\]>\('\/admin\/containers'\)/);
    expect(src).toMatch(/创建请到用户面/);
    expect(src).not.toMatch(/代建/);
    expect(src).not.toMatch(/AdminCreateContainerDialog/);
    expect(src).not.toMatch(/api\.post<IntentAcceptedDto>\('\/admin\/containers'/);
  });

  it('shared-volumes-page never calls /admin/*', () => {
    const src = readPage('shared-volumes-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(src).not.toMatch(/ownerId/);
  });

  it('shared-backends-page stays on admin shared-volumes API', () => {
    const list = readPage('shared-backends-page.tsx');
    const detail = readPage('shared-backend-detail-page.tsx');
    expect(list).not.toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(detail).toMatch(/api\.get<SharedVolumeDto\[\]>\('\/admin\/shared-volumes'\)/);
    expect(detail).not.toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(detail).toMatch(/SharedVolumeCatalogInspectDialog/);
    expect(detail).toMatch(/enabled: tab === 'volumes' && canManageSharedVolumes/);
  });

  it('dashboard-page never calls /admin/* or capability plane switch', () => {
    const src = readPage('dashboard-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ViewMetricsAll/);
    expect(src).not.toMatch(/ManageContainersAny/);
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/to="\/containers\/\$containerId"/);
  });

  it('quota-page never calls /admin/* and stays on user grant APIs', () => {
    const src = readPage('quota-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ManageContainersAny/);
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/api\.get<EffectiveAccessDto>\('\/me\/access'\)/);
    expect(src).toMatch(/api\.get<UserServerDto\[\]>\('\/servers'\)/);
    expect(src).toMatch(/api\.get<ContainerDto\[\]>\('\/containers'\)/);
    expect(src).toMatch(/api\.get<SharedBackendDto\[\]>\('\/shared-backends'\)/);
    expect(src).toMatch(/storage-capacity/);
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
