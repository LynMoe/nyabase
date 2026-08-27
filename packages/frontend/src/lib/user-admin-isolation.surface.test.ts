import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pages = join(here, '..', 'pages');

function readPage(name: string): string {
  return readFileSync(join(pages, name), 'utf8');
}

describe('user panel pages stay on user API plane', () => {
  it('volumes-page never calls /admin/* or ManageVolumes plane switch', () => {
    const src = readPage('volumes-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ManageVolumes/);
    expect(src).toMatch(/api\.get<VolumeDto\[\]>\('\/volumes'\)/);
    expect(src).not.toMatch(/ownerId/);
  });

  it('manage-volumes-page stays on admin volumes API and ManageVolumes', () => {
    const src = readPage('manage-volumes-page.tsx');
    expect(src).toMatch(/api\.get<VolumeDto\[\]>\('\/admin\/volumes'\)/);
    expect(src).not.toMatch(/api\.get<VolumeDto\[\]>\('\/volumes'\)/);
  });

  it('dashboard-page never calls /admin/* or capability plane switch', () => {
    const src = readPage('dashboard-page.tsx');
    expect(src).not.toMatch(/['`]\/admin\//);
    expect(src).not.toMatch(/ViewMetricsAll/);
    expect(src).not.toMatch(/ManageContainersAny/);
    expect(src).not.toMatch(/\/manage\/containers/);
    expect(src).toMatch(/to="\/containers\/\$containerId"/);
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
