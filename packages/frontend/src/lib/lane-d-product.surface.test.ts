import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN_INTENT_CAPABILITIES, Capability } from '@nyabase/common';

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

  it('renders generic server-card support checks without importing card packages', () => {
    const src = [
      read('pages/server-detail-page.tsx'),
      read('components/servers/server-extension-support.tsx'),
    ].join('\n');
    expect(src).not.toMatch(/@nyabase\/[a-z0-9-]+-web/);
    expect(src).toMatch(/item\.support/);
    expect(src).toMatch(/本机检测/);
    expect(src).toMatch(/不阻止启用/);
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
    const page = read('pages/volumes-page.tsx');
    const table = read('components/storage/local-volume-table.tsx');
    const dialog = read('components/storage/local-volume-detail-dialog.tsx');
    const volumes = [page, table, dialog].join('\n');
    expect(volumes).toMatch(/volume\.attachments/);
    expect(volumes).toMatch(/挂载于/);
    expect(volumes).toMatch(/请打开目标容器详情/);
    expect(volumes).toMatch(/ResourceIntentFailures/);
    expect(volumes).toMatch(/ResourceIntentHistory/);
    expect(volumes).toMatch(/\/volumes\/\$\{volume\.id\}\/intents/);
    expect(volumes).not.toMatch(/volumeAttachments\(/);
    expect(page).toMatch(/volume-server-table/);
    expect(page).not.toMatch(/\/admin\//);
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
    expect(layout).not.toMatch(/to: '\/manage\/volumes'/);
    const storageTab = read('components/servers/server-storage-tab.tsx');
    expect(storageTab).toMatch(/ManageVolumes/);
    expect(storageTab).toMatch(/\/admin\/volumes\?serverId=/);
    expect(storageTab).toMatch(/server-volume-table/);
  });

  it('admin shared volumes nav requires ManageSharedVolumes', () => {
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).not.toMatch(/to: '\/manage\/shared-volumes'/);
    expect(layout).not.toMatch(/共享卷管理/);
    expect(layout).toMatch(/to: '\/shared-volumes'/);
    const page = [
      read('pages/shared-backends-page.tsx'),
      read('pages/shared-backend-detail-page.tsx'),
    ].join('\n');
    expect(page).toMatch(/\/admin\/shared-volumes/);
    expect(page).toMatch(/ManageSharedVolumes/);
    expect(page).toMatch(/enabled: tab === 'volumes' && canManageSharedVolumes/);
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
    const volumes = [
      read('pages/volumes-page.tsx'),
      read('components/storage/local-volume-table.tsx'),
      read('components/storage/local-volume-detail-dialog.tsx'),
    ].join('\n');
    const shared = [
      read('pages/shared-volumes-page.tsx'),
      read('components/storage/shared-volume-table.tsx'),
      read('components/storage/shared-volume-detail-dialog.tsx'),
    ].join('\n');
    const localForm = read('components/storage/local-volume-form-dialog.tsx');
    const sharedForm = [
      read('components/storage/shared-volume-form-dialog.tsx'),
      read('lib/shared-backend-executor.ts'),
    ].join('\n');
    const storage = read('components/containers/storage-panel.tsx');
    const inspect = read('components/storage/shared-volume-catalog-inspect.tsx');
    const grants = read('components/grants/canonical-grant-panel.tsx');
    const backends = [
      read('pages/shared-backends-page.tsx'),
      read('pages/shared-backend-detail-page.tsx'),
      read('components/storage/shared-volume-table.tsx'),
      read('components/storage/shared-volume-detail-dialog.tsx'),
    ].join('\n');
    const pools = read('components/servers/pools-card.tsx');
    const detail = read('pages/container-detail-page.tsx');
    expect(volumes).toMatch(/服务器本地盘/);
    expect(volumes).not.toMatch(/锚定存储池/);
    expect(volumes).toMatch(/ResourceIntentHistory/);
    expect(shared).toMatch(/SharedVolumeFormDialog/);
    expect(shared).toMatch(/ResourceIntentHistory/);
    expect(shared).toMatch(/\/shared-volumes\/\$\{volume\.id\}\/intents/);
    expect(shared).toMatch(/formatObservedUsage/);
    expect(shared).not.toMatch(/usedBytes \?\? 0/);
    expect(backends).toMatch(/formatObservedUsage/);
    expect(backends).not.toMatch(/usedBytes \?\? 0/);
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
    expect(backends).toMatch(/发现执行端/);
    expect(backends).toMatch(/执行端/);
    expect(backends).not.toMatch(/查看 catalog/);
    expect(backends).not.toMatch(/\/manage\/shared-volumes/);
    expect(backends).toMatch(/ManageSharedVolumes/);
    expect(backends).toMatch(/\/admin\/shared-volumes/);
    expect(backends).toMatch(/enabled: tab === 'volumes' && canManageSharedVolumes/);
    expect(backends).not.toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(sharedForm).toMatch(/backendLacksOnlineExecutor/);
    expect(sharedForm).toMatch(/hasOnlineExecutor/);
    expect(detail).toMatch(/确认取消/);
    expect(detail).not.toMatch(/卸载前请先停止容器/);
    expect(backends).toMatch(/排障/);
    expect(backends).toMatch(/SharedVolumeCatalogInspectDialog/);
    expect(pools).toMatch(/CephFS 执行端/);
    expect(read('pages/shared-backend-detail-page.tsx')).toMatch(/shared-backend-executors/);
    expect(read('pages/shared-backends-page.tsx')).toMatch(/to: '\/shared-backends\/\$id'/);
    expect(read('pages/image-detail-page.tsx')).toMatch(/image-fingerprint-assignment/);
    expect(read('lib/image-detail.ts')).toMatch(/parseImageDetailTab/);
    expect(read('lib/shared-backend-detail.ts')).toMatch(/parseSharedBackendDetailTab/);
    expect(read('routes/shared-backends/$id.tsx')).toMatch(/parseSharedBackendDetailTab/);
    expect(read('pages/users-page.tsx')).toMatch(/to="\/users\/\$id"/);
    expect(read('pages/users-page.tsx')).not.toMatch(/CanonicalGrantPanel/);
    expect(read('pages/users-page.tsx')).not.toMatch(/setGrantUser/);
    expect(read('pages/user-detail-page.tsx')).toMatch(/user-detail-tabs/);
    expect(read('pages/user-detail-page.tsx')).toMatch(/kind="users"/);
    expect(read('pages/user-detail-page.tsx')).toMatch(/title="用户组"/);
    expect(read('pages/user-detail-page.tsx')).toMatch(/title="能力"/);
    expect(read('pages/groups-page.tsx')).toMatch(/to="\/groups\/\$id"/);
    expect(read('pages/groups-page.tsx')).not.toMatch(/CanonicalGrantPanel/);
    expect(read('pages/groups-page.tsx')).not.toMatch(/setGrantGroup/);
    expect(read('pages/group-detail-page.tsx')).toMatch(/group-detail-tabs/);
    expect(read('pages/group-detail-page.tsx')).toMatch(/kind="groups"/);
    expect(read('pages/group-detail-page.tsx')).toMatch(/title="能力"/);
    expect(read('pages/group-detail-page.tsx')).toMatch(/title="成员"/);
    expect(read('pages/group-detail-page.tsx')).toMatch(/to="\/users\/\$id"/);
    expect(read('lib/user-detail.ts')).toMatch(/parseUserDetailTab/);
    expect(read('lib/group-detail.ts')).toMatch(/parseGroupDetailTab/);
    expect(read('routes/users/$id.tsx')).toMatch(/parseUserDetailTab/);
    expect(read('routes/groups/$id.tsx')).toMatch(/parseGroupDetailTab/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/sharedBackendId:/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/isLocalStoragePool/);
    expect(read('components/grants/canonical-grant-panel.tsx')).not.toMatch(/isLocalStoragePool/);
  });

  it('drops storage-pools nav and hosts server detail behind seven tabs', () => {
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).not.toMatch(/to: '\/storage-pools'/);
    const detail = read('pages/server-detail-page.tsx');
    expect(detail).toMatch(/\bTabs\b/);
    expect(detail).toMatch(/parseServerDetailTab/);
    expect(detail).toMatch(/SERVER_DETAIL_TABS/);
    expect(detail).toMatch(/'overview'/);
    expect(detail).toMatch(/'connect'/);
    expect(detail).toMatch(/'storage'/);
    expect(detail).toMatch(/'preflight'/);
    expect(detail).toMatch(/'metrics'/);
    expect(detail).toMatch(/'extensions'/);
    expect(detail).toMatch(/'activity'/);
    expect(detail).toMatch(/概览/);
    expect(detail).toMatch(/接入/);
    expect(detail).toMatch(/存储/);
    expect(detail).toMatch(/检查/);
    expect(detail).toMatch(/监控/);
    expect(detail).toMatch(/扩展/);
    expect(detail).toMatch(/活动/);
    expect(detail).toMatch(/已登记 \$\{registeredPoolCount\} 个/);
    expect(read('routes/servers/$id.tsx')).toMatch(/parseServerDetailTab/);
    expect(read('routes/servers/$id.tsx')).not.toMatch(/'overview'/);
  });

  it('renders grant quotas as one scroll with nested pools and extension chips', () => {
    const grants = read('components/grants/canonical-grant-panel.tsx');
    const summary = read('components/grants/subject-grant-summary.tsx');
    const quota = read('lib/grant-quota.ts');
    const coreGrant = [grants, summary, quota].join('\n');
    expect(grants).not.toMatch(/\bTabs(Trigger|List|Content)?\b/);
    expect(grants).not.toMatch(/from '\.\.\/ui\/tabs/);
    expect(grants).toMatch(/formatGrantQuotaLine/);
    expect(grants).toMatch(/formatExtensionGrantSummaries/);
    expect(grants).toMatch(/存储池（无服务器授权）/);
    expect(grants).toMatch(/磁盘（G，空=不限，不含共享卷）/);
    expect(grants).toMatch(/SectionCard/);
    expect(grants).toMatch(/grant-servers/);
    expect(grants).toMatch(/grant-pools/);
    expect(grants).toMatch(/grant-backends/);
    expect(grants).not.toMatch(/aria-expanded/);
    expect(grants).not.toMatch(/isLocalStoragePool/);
    expect(summary).toMatch(/formatGrantQuotaLine/);
    expect(summary).toMatch(/formatExtensionGrantSummaries/);
    expect(summary).toMatch(/池：/);
    expect(summary).toMatch(/存储池 /);
    expect(quota).toMatch(/formatConsumedQuotaParts/);
    expect(quota).not.toMatch(/extensions\/registry/);
    expect(coreGrant).not.toMatch(/nvidia-gpu/);
    expect(coreGrant).not.toMatch(/pciAddresses/);
    expect(coreGrant).not.toMatch(/GpuGrantMode/);
  });

  it('gates /ops with the six admin intent capabilities and does not expand Operators', () => {
    expect([...ADMIN_INTENT_CAPABILITIES]).toEqual([
      Capability.ManageContainersAny,
      Capability.ManageVolumes,
      Capability.ManageSharedVolumes,
      Capability.ManageServers,
      Capability.ManageImages,
      Capability.ManageCertificates,
    ]);
    expect(ADMIN_INTENT_CAPABILITIES).toHaveLength(6);
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).toMatch(/to: '\/ops'/);
    expect(layout).toMatch(/运维/);
    expect(layout).toMatch(/ADMIN_INTENT_CAPABILITIES/);
    const route = read('routes/ops/index.tsx');
    expect(route).toMatch(/ADMIN_INTENT_CAPABILITIES/);
    expect(route).toMatch(/RequireAnyCapability/);
    const ops = read('pages/ops-page.tsx');
    expect(ops).toMatch(/status', 'pending'/);
    expect(ops).toMatch(/status', 'failed'/);
    expect(ops).toMatch(/加载更多/);
    expect(ops).toMatch(/useInfiniteQuery/);
    expect(ops).not.toMatch(/机器状态/);
    expect(ops).toMatch(/useState<StatusSegment>\('all'\)/);
    expect(ops).not.toMatch(/enabled: segment != null/);
    expect(ops).not.toMatch(/选择『全部』『进行中』或『失败』加载意图/);
    expect(ops).not.toMatch(/默认不加载/);
    expect(ops).toMatch(/ManageServers/);
    expect(ops).not.toMatch(/WebSocket|useWebSocket/);
    const dialog = read('components/intents/intent-detail-dialog.tsx');
    expect(dialog).toMatch(/sm:max-w-3xl/);
    const groups = readFileSync(join(root, '../../backend/src/groups/groups.service.ts'), 'utf8');
    const operatorsBlock = groups.match(/SystemGroupKey\.Operators,[\s\S]*?\],\s*\)/)?.[0] ?? '';
    expect(operatorsBlock).toMatch(/Capability\.ManageServers/);
    expect(operatorsBlock).toMatch(/Capability\.ManageContainersAny/);
    expect(operatorsBlock).not.toMatch(/ManageVolumes/);
    expect(operatorsBlock).not.toMatch(/ManageSharedVolumes/);
  });

  it('shows grant ceilings and remaining on user surfaces', () => {
    const dashboard = read('pages/dashboard-page.tsx');
    const create = read('components/containers/create-container-dialog.tsx');
    const local = read('components/storage/local-volume-form-dialog.tsx');
    const shared = read('components/storage/shared-volume-form-dialog.tsx');
    const volumes = read('pages/volumes-page.tsx');
    const sharedPage = read('pages/shared-volumes-page.tsx');
    expect(dashboard).toMatch(/额度/);
    expect(dashboard).toMatch(/已分配/);
    expect(dashboard).toMatch(/已预订/);
    expect(dashboard).toMatch(/formatGrantQuotaLine/);
    expect(dashboard).toMatch(/formatConsumedQuotaParts/);
    expect(dashboard).toMatch(/formatExtensionGrantSummaries/);
    expect(dashboard).not.toMatch(/nvidia-gpu/);
    expect(dashboard).not.toMatch(/pciAddresses/);
    expect(dashboard).not.toMatch(/GpuGrantMode/);
    expect(create).toMatch(/formatGrantQuotaLine/);
    expect(create).toMatch(/formatConsumedQuotaParts/);
    expect(create).toMatch(/queryKeys\.containers\.userList/);
    expect(create).toMatch(/\/containers/);
    expect(create).not.toMatch(/nvidia-gpu/);
    expect(create).not.toMatch(/pciAddresses/);
    expect(create).not.toMatch(/GpuGrantMode/);
    expect(local).toMatch(/queryKeys\.storageCapacity/);
    expect(local).toMatch(/storage-capacity/);
    expect(shared).toMatch(/剩余/);
    expect(shared).toMatch(/额度/);
    expect(shared).toMatch(/sharedBackends/);
    expect(volumes).toMatch(/queryKeys\.storageCapacity/);
    expect(volumes).toMatch(/storage-capacity/);
    expect(sharedPage).toMatch(/sharedBackends/);
  });
});
