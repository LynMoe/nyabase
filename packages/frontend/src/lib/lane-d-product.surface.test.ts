import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function read(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

describe('lane D product UI copy', () => {
  it('gates pool register and cert rotate without expanding Operator caps', () => {
    const src = read('pages/server-detail-page.tsx');
    expect(src).toMatch(/ManageStoragePools/);
    expect(src).toMatch(/ManageCertificates/);
    expect(src).toMatch(/可以查看存储池，但登记与取消登记需要「管理存储池」权限/);
    expect(src).toMatch(/可以查看证书状态，但轮换需要「管理证书」权限/);
    expect(src).toMatch(/更改系统盘池只影响之后新建的容器，不会改动已有容器/);
    expect(src).toMatch(/信任新证书/);
    expect(src).toMatch(/撤销旧证书/);
  });

  it('prompts rebuild when NVIDIA runtime is off and retries failed intents', () => {
    const src = read('pages/container-detail-page.tsx');
    expect(src).toMatch(/该容器创建时未启用 NVIDIA runtime，无法热添加 GPU，请删除后重建/);
    expect(src).toMatch(/挂载与卸载需要「管理数据卷」权限/);
    expect(src).toMatch(/retryIntent/);
    expect(src).toMatch(/formatIntentAttempt/);
    expect(src).toMatch(/filterAttachableVolumes/);
  });

  it('shows typed volume attachments and a layout cert expiry banner', () => {
    const volumes = read('pages/volumes-page.tsx');
    expect(volumes).toMatch(/volume\.attachments/);
    expect(volumes).toMatch(/挂载于/);
    expect(volumes).not.toMatch(/volumeAttachments\(/);
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).toMatch(/cert-expiry-banner/);
    expect(layout).toMatch(/certExpiryBannerText/);
    expect(layout).toMatch(/canViewCertificate|ManageServers/);
    expect(layout).toMatch(/前往轮换/);
  });

  it('console waits for protocol ready/error instead of websocket open', () => {
    const src = read('components/containers/container-console.tsx');
    expect(src).toMatch(/zConsoleToBrowser/);
    expect(src).toMatch(/message\.type === 'ready'/);
    expect(src).toMatch(/message\.type === 'error'/);
    const openBlock = src.match(/addEventListener\('open', \(\) => \{[\s\S]*?\}\);/);
    expect(openBlock?.[0]).toMatch(/type: 'auth'/);
    expect(openBlock?.[0]).not.toMatch(/setStatus\('connected'\)/);
  });

  it('admin volumes nav requires ManageVolumes', () => {
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).toMatch(/\/manage\/volumes/);
    expect(layout).toMatch(/Capability\.ManageVolumes/);
    const page = read('pages/manage-volumes-page.tsx');
    expect(page).toMatch(/\/admin\/volumes/);
  });

  it('volume remount waits for attachment after 202 and blocks quota-ineffective create', () => {
    const remount = read('components/storage/volume-shrink-orchestration-dialog.tsx');
    expect(remount).toMatch(/等待挂回/);
    expect(remount).toMatch(/lookupLatestIntentFailure/);
    const volumes = read('pages/volumes-page.tsx');
    expect(volumes).toMatch(/quotaEffective !== true/);
    expect(volumes).toMatch(/quotaIneffectiveCreateHint/);
    const detail = read('pages/container-detail-page.tsx');
    expect(detail).not.toMatch(/已用\/待应用/);
    expect(detail).toMatch(/observedRootUsedBytes/);
  });
});
