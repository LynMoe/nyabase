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

function assertScopeAllOnly(src: string, pattern: RegExp) {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  const matches = [...src.matchAll(global)];
  expect(matches.length).toBeGreaterThan(0);
  for (const match of matches) {
    const start = match.index ?? 0;
    const window = src.slice(Math.max(0, start - 280), start);
    const last = [...window.matchAll(/scope === '(all|mine)'/g)].pop();
    expect(last?.[1], `${match[0]} must sit in scope === 'all'`).toBe('all');
  }
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

  it('local-volume-table gates admin links behind scope === all', () => {
    const src = [
      readSrc('components/storage/local-volume-table.tsx'),
      readSrc('components/storage/local-volume-table.tsx'),
    ].join('\n');
    expect(src).not.toMatch(/['`]\/admin\//);
    assertScopeAllOnly(src, /\/manage\/containers/);
    expect(src).toMatch(/scope === 'mine'/);
    expect(src).toMatch(/resourceIntentsPath\(scope, IntentResourceType\.Volume, volume\.id\)/);
    expect(src).toMatch(/to="\/containers\/\$containerId"/);
  });

  it('local-volume-form-dialog uses one volumes route and gates scope=all by scope', () => {
    const src = [readSrc('components/storage/local-volume-form-dialog.tsx')].join('\n');
    expect(src).not.toMatch(/['`]\/admin\//);
    assertScopeAllOnly(src, /\?scope=all/);
    expect(src).not.toMatch(/api\.post<unknown>\('\/volumes\?/);
    expect(src).toMatch(/api\.patch<IntentAcceptedDto \| VolumeDto>\(`\/volumes\/\$\{volumeId\}`/);
    expect(src).not.toMatch(/ownerId/);
    expect(src).not.toMatch(/所有者 UUID/);
  });

  it('manage-containers-page lists and operates without admin create', () => {
    const src = readPage('manage-containers-page.tsx');
    expect(src).toMatch(/api\.get<ContainerDto\[\]>\('\/containers\?scope=all'\)/);
    expect(src).toMatch(/新建容器请到「容器」页/);
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

  it('dashboard performance stays on the user usage API', () => {
    const src = readPage('dashboard-page.tsx');
    expect(src).toMatch(/\/performance\/usage'/);
    expect(src).not.toMatch(/\/admin\/performance|scope=all/);
    expect(src).not.toMatch(/PerformancePanel/);
  });

  it('servers page mounts the scope=all performance view', () => {
    const src = readPage('servers-page.tsx');
    expect(src).toMatch(/\/performance\/usage\?scope=all'/);
    expect(src).toMatch(/ViewMetricsAll/);
    expect(src).not.toMatch(/PerformancePanel/);
  });

  it('dashboard-page never calls /admin/* or capability plane switch', () => {
    const src = readPage('dashboard-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ViewMetricsAll/);
    expect(src).not.toMatch(/ManageContainersAny/);
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/to="\/containers\/\$containerId"/);
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
