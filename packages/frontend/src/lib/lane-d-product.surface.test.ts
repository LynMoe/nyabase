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
    const src = [
      read('pages/server-detail-page.tsx'),
      read('components/servers/pools-card.tsx'),
      read('components/servers/certificate-card.tsx'),
    ].join('\n');
    expect(src).toMatch(/ManageStoragePools/);
    expect(src).toMatch(/ManageCertificates/);
    expect(src).toMatch(/可以查看存储池，但登记与取消登记需要「管理存储池」权限/);
    expect(src).toMatch(/可以查看证书状态，但轮换需要「管理证书」权限/);
    expect(src).toMatch(/更改系统盘池只影响之后新建的容器，不会改动已有容器/);
    expect(src).toMatch(/信任新证书/);
    expect(src).toMatch(/撤销旧证书/);
  });

  it('retries failed intents without importing card-extension packages on container pages', () => {
    const src = [
      read('pages/container-detail-page.tsx'),
      read('components/containers/spec-panel.tsx'),
      read('components/containers/intents-panel.tsx'),
    ].join('\n');
    expect(src).not.toMatch(/@nyabase\/[a-z0-9-]+-web/);
    expect(src).toMatch(/ExtensionSlots/);
    expect(src).toMatch(/挂载与卸载本地数据卷需要「管理本地数据卷」权限/);
    expect(src).toMatch(/挂载与卸载共享卷需要「管理共享卷」权限/);
    expect(src).toMatch(/retryIntent/);
    expect(src).toMatch(/formatIntentAttempt/);
    expect(src).toMatch(/filterAttachableVolumes/);
    expect(src).toMatch(/filterAttachableSharedVolumes/);
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

  it('admin shared volumes nav requires ManageSharedVolumes', () => {
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).toMatch(/\/manage\/shared-volumes/);
    expect(layout).toMatch(/Capability\.ManageSharedVolumes/);
    expect(layout).toMatch(/to: '\/shared-volumes'/);
    const page = read('pages/manage-shared-volumes-page.tsx');
    expect(page).toMatch(/\/admin\/shared-volumes/);
  });

  it('volume remount waits for attachment after 202 and blocks quota-ineffective create', () => {
    const remount = read('components/storage/volume-shrink-orchestration-dialog.tsx');
    expect(remount).toMatch(/等待挂回/);
    expect(remount).toMatch(/lookupLatestIntentFailure/);
    const volumes = [
      read('pages/volumes-page.tsx'),
      read('components/storage/local-volume-form-dialog.tsx'),
    ].join('\n');
    expect(volumes).toMatch(/quotaEffective !== true/);
    expect(volumes).toMatch(/quotaIneffectiveCreateHint/);
    const detail = read('pages/container-detail-page.tsx');
    expect(detail).not.toMatch(/已用\/待应用/);
    expect(detail).toMatch(/observedRootUsedBytes/);
  });

  it('splits local and shared volume products and inspect-only catalogs', () => {
    const volumes = read('pages/volumes-page.tsx');
    const shared = read('pages/shared-volumes-page.tsx');
    const localForm = read('components/storage/local-volume-form-dialog.tsx');
    const sharedForm = [
      read('components/storage/shared-volume-form-dialog.tsx'),
      read('lib/shared-backend-executor.ts'),
    ].join('\n');
    const storage = read('components/containers/storage-panel.tsx');
    const inspect = read('components/storage/shared-volume-catalog-inspect.tsx');
    const grants = read('components/grants/canonical-grant-panel.tsx');
    const backends = read('pages/shared-backends-page.tsx');
    const adminShared = read('pages/manage-shared-volumes-page.tsx');
    const pools = read('pages/storage-pools-page.tsx');
    const detail = read('pages/container-detail-page.tsx');
    expect(volumes).toMatch(/服务器本地盘/);
    expect(volumes).not.toMatch(/锚定存储池/);
    expect(shared).toMatch(/SharedVolumeFormDialog/);
    expect(localForm).toMatch(/volume-server/);
    expect(localForm).toMatch(/volume-pool/);
    expect(localForm).not.toMatch(/volume-shared-backend/);
    expect(localForm).not.toMatch(/\/shared-volumes/);
    expect(sharedForm).toMatch(/volume-shared-backend/);
    expect(sharedForm).not.toMatch(/volume-server/);
    expect(sharedForm).not.toMatch(/volume-pool/);
    expect(sharedForm).not.toMatch(/锚定存储池/);
    expect(sharedForm).toMatch(/已创建/);
    expect(sharedForm).toMatch(/现在还不能挂载或销毁已有目录/);
    expect(sharedForm).toMatch(/queryKeys\.sharedVolumes\.all/);
    expect(shared).toMatch(/queryKeys\.sharedVolumes\.all/);
    expect(storage).not.toMatch(/热卸载/);
    expect(storage).not.toMatch(/热挂载/);
    expect(storage).toMatch(/先停止容器/);
    expect(storage).toMatch(/取消挂载/);
    expect(storage).toMatch(/onlineCancelAllowed/);
    expect(inspect).toMatch(/catalogOccupancyLabel/);
    expect(inspect).toMatch(/shouldSkipCatalogInspectRow/);
    expect(inspect).not.toMatch(/强制/);
    expect(inspect).not.toMatch(/修复/);
    expect(inspect).not.toMatch(/mutate/);
    expect(grants).toMatch(/磁盘（G，空=不限，不含共享卷）/);
    expect(backends).toMatch(/\/manage\/shared-volumes/);
    expect(backends).toMatch(/查看 catalog/);
    expect(backends).toMatch(/ManageSharedVolumes/);
    expect(sharedForm).toMatch(/backendLacksOnlineExecutor/);
    expect(sharedForm).toMatch(/hasOnlineExecutor/);
    expect(detail).toMatch(/确认取消/);
    expect(detail).not.toMatch(/卸载前请先停止容器/);
    expect(adminShared).toMatch(/查看 catalog/);
    expect(adminShared).toMatch(/SharedVolumeCatalogInspectDialog/);
    expect(pools).toMatch(/不列出逻辑共享卷/);
  });
});
