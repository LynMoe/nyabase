import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource, readSourceDir } from './read-source.test-helper.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function read(rel: string): string {
  return readSource(root, rel);
}

function readDir(rel: string): string {
  return readSourceDir(root, rel);
}

describe('lane D product UI copy', () => {
  it('gates pool register to admins', () => {
    const src = [
      read('pages/server-detail-page.tsx'),
      read('components/servers/pools-card.tsx'),
    ].join('\n');
    expect(src).toMatch(/ManageStoragePools/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/位置/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/备注/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/编辑备注/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/TechnicalId/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/storagePoolSourceKind/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/aria-label="编辑备注"/);
    expect(read('components/servers/pools-card.tsx')).toMatch(/storage-pool-edit-remark/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/config\.source/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/cephfs\.path/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/@nyabase\/nvidia-gpu/);
  });

  it('renders GPU support checks on the server GPU tab', () => {
    const src = [
      read('pages/server-detail-page.tsx'),
      read('components/gpu/gpu-sections.tsx'),
      read('components/gpu/gpu-picker.tsx'),
    ].join('\n');
    expect(src).not.toMatch(/@nyabase\/[a-z0-9-]+-web/);
    expect(src).toMatch(/gpu\.support/);
    expect(src).toMatch(/本机检测/);
  });

  it('retries failed intents and renders GPU sections on container pages', () => {
    const src = [
      read('pages/container-detail-page.tsx'),
      read('components/containers/spec-panel.tsx'),
      read('components/containers/overview-panel.tsx'),
      read('components/containers/storage-panel.tsx'),
      read('components/containers/intents-panel.tsx'),
    ].join('\n');
    expect(src).not.toMatch(/@nyabase\/[a-z0-9-]+-web/);
    expect(src).toMatch(/ContainerOverviewGpu/);
    expect(src).toMatch(/ContainerSpecGpu/);
    expect(src).toMatch(/编辑规格/);
    expect(src).toMatch(/调整容量/);
    expect(src).not.toMatch(/\['spec', '规格'/);
    expect(src).toMatch(/需要「管理本地数据卷」权限/);
    expect(src).toMatch(/需要「管理共享卷」权限/);
    expect(src).toMatch(/retryIntent/);
    expect(src).toMatch(/formatIntentAttempt/);
    expect(src).toMatch(/filterAttachableVolumes/);
    expect(src).toMatch(/filterAttachableSharedVolumes/);
  });

  it('shows typed volume attachments and a layout cert expiry banner', () => {
    const page = read('pages/volumes-page.tsx');
    const table = read('components/storage/local-volume-table.tsx');
    const dialog = read('components/storage/local-volume-table.tsx');
    const volumes = [page, table, dialog].join('\n');
    expect(volumes).toMatch(/volume\.attachments/);
    expect(volumes).toMatch(/挂载于/);
    expect(volumes).toMatch(/未挂载/);
    expect(volumes).toMatch(/ResourceIntentFailures/);
    expect(volumes).toMatch(/ResourceIntentHistory/);
    expect(volumes).toMatch(/resourceIntentsPath\(scope, IntentResourceType\.Volume, volume\.id\)/);
    expect(volumes).not.toMatch(/volumeAttachments\(/);
    expect(page).toMatch(/volume-server-table/);
    expect(page).not.toMatch(/\/admin\//);
    // Servers are reached through the host agent: no Incus trust token, no client certificate.
    const servers = readDir('components/servers');
    expect(servers).not.toMatch(/incus-client-identity|trustToken|\/connect`/);
    const agent = read('components/servers/agent-card.tsx');
    expect(agent).toMatch(/\/agent-enrollment/);
    expect(agent).toMatch(/expectedRevision: server\.revision/);
    expect(read('components/servers/agent-enrollment.tsx')).toMatch(/NYABASE_AGENT_ENROLLMENT_TOKEN/);
    expect(read('pages/servers-page/server-onboarding-dialog.tsx')).toMatch(/EnrollmentInstructions/);
    expect(read('components/layout/app-layout.tsx')).not.toMatch(/Cert/);
  });

  it('console waits for protocol ready/error instead of websocket open', () => {
    const src = read('components/containers/container-console.tsx');
    expect(src).toMatch(/zConsoleToBrowser/);
    expect(src).toMatch(/message\.type === 'ready'/);
    expect(src).toMatch(/message\.type === 'error'/);
    const openBlock = src.match(/addEventListener\('open', \(\) => \{[\s\S]*?\}\);/);
    expect(openBlock?.[0]).toMatch(/type: 'auth'/);
    expect(openBlock?.[0]).not.toMatch(/setStatus\('connected'\)/);
    expect(src).toMatch(/consoleErrorMessage\(message\.code, message\.message\)/);
    expect(src).toMatch(/consoleCloseMessage\(event\.code\)/);
    expect(src).not.toMatch(/setError\(message\.message/);
  });

  it('console answers reauthenticate with a fresh access token of the same session', () => {
    const src = read('components/containers/container-console.tsx');
    expect(src).toMatch(/message\.type === 'reauthenticate'/);
    expect(src).toMatch(/freshAccessTokenWithRetry\(auth\.sentToken, open\)/);
  });

  it('profile page offers no API tokens: the browser session is the only credential', () => {
    const src = read('pages/profile-page.tsx');
    expect(src).not.toMatch(/API 令牌|ApiToken|\/auth\/tokens/);
    expect(src).toMatch(/autoComplete="current-password"/);
  });

  it('image catalog is list/add/repull/remove without free-form fields', () => {
    const page = read('pages/images-page.tsx');
    const catalog = read('components/images/image-catalog-dialog.tsx');
    const list = read('components/images/image-list.tsx');
    const detail = read('pages/image-detail-page.tsx');
    expect(page).toMatch(/ImageCatalogDialog/);
    expect(page).not.toMatch(/ImageFormDialog/);
    expect(catalog).toMatch(/'\/images\/catalog'/);
    expect(catalog).toMatch(/\{ alias \}/);
    expect(catalog).not.toMatch(/loginUser/);
    expect(list).toMatch(/拉取最新版本/);
    expect(list).toMatch(/移除/);
    expect(list).toMatch(/image\.alias/);
    expect(list).not.toMatch(/image\.name/);
    expect(detail).not.toMatch(/ImageFormDialog/);
    expect(detail).not.toMatch(/loaded\.name/);
    expect(detail).toMatch(/拉取最新版本/);
  });

  it('admin volumes nav requires ManageVolumes', () => {
    const layout = read('components/layout/app-layout.tsx');
    expect(layout).not.toMatch(/to: '\/manage\/volumes'/);
    const storageTab = read('components/servers/server-storage-tab.tsx');
    expect(storageTab).toMatch(/ManageVolumes/);
    expect(storageTab).toMatch(/\/volumes\?scope=all&serverId=/);
    expect(storageTab).toMatch(/server-volume-table/);
  });

  it('admin shared volumes nav requires ManageSharedVolumes', () => {
    const layout = read('lib/navigation.ts');
    expect(layout).not.toMatch(/to: '\/manage\/shared-volumes'/);
    expect(layout).not.toMatch(/共享卷管理/);
    expect(layout).toMatch(/to: '\/shared-volumes'/);
    const page = [
      read('pages/shared-backends-page.tsx'),
      read('pages/shared-backend-detail-page.tsx'),
    ].join('\n');
    expect(page).toMatch(/\/shared-volumes\?scope=all/);
    expect(page).toMatch(/useHasRole\(Role\.Admin\)/);
    expect(page).toMatch(/enabled: canManageVolumes,/);
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
    const detail = [
      read('pages/container-detail-page.tsx'),
      read('components/containers/spec-panel.tsx'),
      read('components/containers/storage-panel.tsx'),
    ].join('\n');
    expect(detail).not.toMatch(/已用\/待应用/);
    expect(detail).toMatch(/observedRootUsedBytes/);
  });

  it('splits local and shared volume products and inspect-only catalogs', () => {
    const volumes = [
      read('pages/volumes-page.tsx'),
      read('components/storage/local-volume-table.tsx'),
      read('components/storage/local-volume-table.tsx'),
    ].join('\n');
    const shared = [
      read('pages/shared-volumes-page.tsx'),
      read('components/storage/shared-volume-table.tsx'),
      read('components/storage/shared-volume-table.tsx'),
    ].join('\n');
    const localForm = read('components/storage/local-volume-form-dialog.tsx');
    const sharedForm = [
      read('components/storage/shared-volume-form-dialog.tsx'),
      read('lib/storage-shrink.ts'),
    ].join('\n');
    const storage = read('components/containers/storage-panel.tsx');
    const inspect = read('components/storage/shared-volume-catalog-inspect.tsx');
    const grants = readDir('components/grants');
    const backends = [
      read('pages/shared-backends-page.tsx'),
      read('pages/shared-backend-detail-page.tsx'),
      read('components/storage/shared-volume-table.tsx'),
      read('components/storage/shared-volume-table.tsx'),
    ].join('\n');
    const detail = [read('pages/container-detail-page.tsx'), read('components/containers/storage-panel.tsx')].join('\n');
    expect(read('pages/volumes-page.tsx')).toMatch(/testId="volumes"/);
    expect(read('pages/volumes-page.tsx')).toMatch(/LocalVolumeTable/);
    expect(read('pages/shared-volumes-page.tsx')).toMatch(/testId="shared-volumes"/);
    expect(volumes).not.toMatch(/锚定存储池/);
    expect(volumes).toMatch(/ResourceIntentHistory/);
    expect(shared).toMatch(/SharedVolumeFormDialog/);
    expect(shared).toMatch(/ResourceIntentHistory/);
    expect(shared).toMatch(/resourceIntentsPath\(scope, IntentResourceType\.Volume, volume\.id\)/);
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
    expect(read('lib/grant-bundle-form.ts')).toMatch(/系统盘（GiB，留空为不限，不含数据盘）/);
    expect(grants).toMatch(/数据盘/);
    expect(backends).toMatch(/发现执行端/);
    expect(backends).toMatch(/执行端/);
    expect(backends).not.toMatch(/查看 catalog/);
    expect(backends).not.toMatch(/\/manage\/shared-volumes/);
    expect(backends).toMatch(/useHasRole\(Role\.Admin\)/);
    expect(backends).toMatch(/\/shared-volumes\?scope=all/);
    expect(backends).toMatch(/enabled: canManageVolumes,/);
    expect(backends).not.toMatch(/api\.get<SharedVolumeDto\[\]>\('\/shared-volumes'\)/);
    expect(sharedForm).toMatch(/backendLacksOnlineExecutor/);
    expect(sharedForm).toMatch(/hasOnlineExecutor/);
    expect(detail).toMatch(/确认取消/);
    expect(detail).not.toMatch(/卸载前请先停止容器/);
    expect(backends).toMatch(/排障/);
    expect(backends).toMatch(/SharedVolumeCatalogInspectDialog/);
    expect(read('pages/shared-backend-detail-page.tsx')).toMatch(/shared-backend-executors/);
    expect(read('pages/shared-backends-page.tsx')).toMatch(/to: '\/shared-backends\/\$id'/);
    expect(read('pages/image-detail-page.tsx')).toMatch(/image-fingerprint-assignment/);
    expect(read('lib/detail-tabs.ts')).toMatch(/parseImageDetailTab/);
    expect(read('lib/detail-tabs.ts')).toMatch(/parseSharedBackendDetailTab/);
    expect(read('routes/shared-backends/$id.tsx')).toMatch(/parseSharedBackendDetailTab/);
    expect(read('pages/users-page.tsx')).toMatch(/to="\/users\/\$id"/);
    expect(read('pages/users-page.tsx')).not.toMatch(/CanonicalGrantPanel/);
    expect(read('pages/users-page.tsx')).not.toMatch(/setGrantUser/);
    expect(read('pages/user-detail-page.tsx')).toMatch(/user-detail-tabs/);
    expect(read('pages/user-detail-page.tsx')).toMatch(/<CanonicalGrantPanel user=\{user\} \/>/);
    expect(read('pages/user-detail-page.tsx')).not.toMatch(/用户组/);
    expect(read('pages/user-detail-page.tsx')).not.toMatch(/title="能力"/);
    expect(read('pages/grant-bundles-page.tsx')).toMatch(/BundleEditDialog/);
    expect(read('pages/grant-bundles-page.tsx')).toMatch(/\/preview/);
    expect(read('pages/grant-bundles-page.tsx')).toMatch(/expectedRevision/);
    expect(read('pages/grant-bundles-page.tsx')).toMatch(/GrantBundleInUse/);
    expect(read('pages/profile-page.tsx')).toMatch(/ssh-key-add/);
    expect(read('pages/profile-page.tsx')).toMatch(/添加公钥/);
    expect(read('lib/detail-tabs.ts')).toMatch(/parseUserDetailTab/);
    expect(read('lib/detail-tabs.ts')).not.toMatch(/Group/);
    expect(read('routes/users/$id.tsx')).toMatch(/parseUserDetailTab/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/sharedBackendId:/);
    expect(read('components/servers/pools-card.tsx')).not.toMatch(/isLocalStoragePool/);
    expect(readDir('components/grants')).not.toMatch(/isLocalStoragePool/);
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
    expect(detail).toMatch(/'gpu'/);
    expect(detail).toMatch(/'activity'/);
    expect(detail).toMatch(/概览/);
    expect(detail).toMatch(/接入/);
    expect(detail).toMatch(/存储/);
    expect(detail).toMatch(/检查/);
    expect(detail).toMatch(/监控/);
    expect(detail).toMatch(/GPU/);
    expect(detail).toMatch(/活动/);
    expect(detail).toMatch(/已登记 \$\{registeredPoolCount\} 个/);
    expect(read('routes/servers/$id.tsx')).toMatch(/parseServerDetailTab/);
    expect(read('routes/servers/$id.tsx')).not.toMatch(/'overview'/);
  });

  it('renders the grants of a user as bundle cards with data disks and a check-to-override form', () => {
    const grants = readDir('components/grants');
    const quota = read('lib/grant-quota.ts');
    const coreGrant = [grants, quota].join('\n');
    expect(grants).not.toMatch(/\bTabs(Trigger|List|Content)?\b/);
    expect(grants).not.toMatch(/from '\.\.\/ui\/tabs/);
    expect(grants).toMatch(/SectionCard/);
    expect(grants).toMatch(/grant-assign/);
    expect(grants).toMatch(/grant-servers/);
    expect(grants).toMatch(/grant-pools-/);
    expect(grants).toMatch(/grant-backends/);
    expect(grants).toMatch(/grant-add-pool-/);
    expect(grants).toMatch(/grant-add-backend/);
    // The top form: pick a bundle, tick「修改」to override a field, replace on 409.
    expect(grants).toMatch(/bundleOptionLabel/);
    expect(grants).toMatch(/>修改</);
    expect(grants).toMatch(/已覆盖/);
    expect(grants).toMatch(/FailureCode\.ServerGrantExists/);
    expect(grants).toMatch(/replace: true/);
    expect(grants).toMatch(/替换后立即生效/);
    expect(grants).toMatch(/\/server-grants\//);
    expect(grants).toMatch(/\/storage-pool-grants\//);
    // GPUs are a count now; no card picker in the grant editor.
    expect(grants).not.toMatch(/GpuPicker|ServerGrantGpu/);
    expect(grants).not.toMatch(/\btoolbar=/);
    expect(grants).not.toMatch(/aria-expanded/);
    expect(grants).not.toMatch(/isLocalStoragePool/);
    expect(grants).not.toMatch(/\/admin\/groups|kind: 'groups'/);
    expect(quota).toMatch(/formatConsumedQuotaParts/);
    expect(coreGrant).not.toMatch(/nvidia-gpu/);
    expect(coreGrant).not.toMatch(/GpuGrantMode/);
  });

  it('gates /ops with the user admin role', () => {
    const nav = read('lib/navigation.ts');
    expect(nav).toMatch(/to: '\/ops'/);
    expect(nav).toMatch(/操作记录/);
    expect(nav).toMatch(/access: ACCESS\.ops/);
    expect(read('lib/route-access.ts')).toMatch(/ops: Role\.UserAdmin/);
    const route = read('routes/ops/index.tsx');
    expect(route).toMatch(/RequireAccess rule=\{ACCESS\.ops\}/);
    const ops = read('pages/ops-page.tsx');
    expect(ops).toMatch(/status', 'pending'/);
    expect(ops).toMatch(/status', 'failed'/);
    // Page-by-page (cursor stack), not infinite loading; the status segments
    // use the shared SegmentedFilter so the active one is highlighted.
    expect(ops).not.toMatch(/加载更多|useInfiniteQuery/);
    expect(ops).toMatch(/useCursorPages\(/);
    expect(ops).toMatch(/<Pagination[\s\S]*hasNext=/);
    expect(ops).toMatch(/<SegmentedFilter/);
    expect(ops).not.toMatch(/variant=\{segment === /);
    expect(ops).not.toMatch(/机器状态/);
    expect(ops).toMatch(/useState<IntentFilterState>\(\{ segment: 'all' \}\)/);
    expect(ops).not.toMatch(/enabled: segment != null/);
    expect(ops).not.toMatch(/选择『全部』『进行中』或『失败』加载意图/);
    expect(ops).not.toMatch(/默认不加载/);
    expect(ops).toMatch(/Role\.UserAdmin/);
    expect(ops).not.toMatch(/WebSocket|useWebSocket/);
    const dialog = read('components/intents/intent-detail-dialog.tsx');
    expect(dialog).toMatch(/sm:max-w-3xl/);
  });

  it('shows grant ceilings and remaining on user surfaces', () => {
    const nav = read('lib/navigation.ts');
    const quotaPage = read('components/quota/quota-summary.tsx');
    const dashboard = read('pages/dashboard-page.tsx');
    const create = read('components/containers/create-container-dialog.tsx');
    const local = read('components/storage/local-volume-form-dialog.tsx');
    const shared = read('components/storage/shared-volume-form-dialog.tsx');
    const volumes = read('pages/volumes-page.tsx');
    const sharedPage = read('pages/shared-volumes-page.tsx');
    // 配额 is a section of 概览, not a separate destination.
    expect(nav).not.toMatch(/to: '\/quota'/);
    expect(read('routes/quota/index.tsx')).toMatch(/redirect\(\{ to: '\/', hash: 'quota'/);
    expect(quotaPage).toMatch(/formatQuotaDimension/);
    expect(quotaPage).toMatch(/formatGpuGrantSummary/);
    expect(quotaPage).toMatch(/storage-capacity/);
    expect(quotaPage).toMatch(/sharedBackends/);
    expect(quotaPage).toMatch(/额度/);
    expect(quotaPage).toMatch(/已分配/);
    expect(quotaPage).toMatch(/剩余/);
    expect(quotaPage).not.toMatch(/nvidia-gpu/);
    expect(quotaPage).not.toMatch(/pciAddresses/);
    expect(quotaPage).not.toMatch(/GpuGrantMode/);
    expect(quotaPage).not.toMatch(/['`]\/admin\//);
    expect(dashboard).toMatch(/<QuotaSummary \/>/);
    expect(dashboard).toMatch(/id="quota"/);
    expect(dashboard).not.toMatch(/formatGrantQuotaLine/);
    expect(dashboard).not.toMatch(/formatConsumedQuotaParts/);
    expect(dashboard).not.toMatch(/nvidia-gpu/);
    expect(dashboard).not.toMatch(/GpuGrantMode/);
    // The dashboard is summary cards plus the quota; per-container usage lives in the container list.
    expect(dashboard).not.toMatch(/incus-container-resources|incus-server-resources/);
    expect(quotaPage).not.toMatch(/绑定|formatCpuList|cpuSet/);
    expect(quotaPage).toMatch(/cpuGrantLabel/);
    // One "remaining" line instead of ceiling + remaining + a capacity box.
    expect(create).toMatch(/create-remaining/);
    expect(create).toMatch(/formatConsumedQuotaParts/);
    expect(create).toMatch(/超出剩余/);
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
    expect(volumes).not.toMatch(/queryKeys\.storageCapacity/);
    expect(volumes).not.toMatch(/storage-capacity/);
    expect(sharedPage).not.toMatch(/sharedBackends/);
    expect(sharedPage).not.toMatch(/formatRemainingBytes/);
  });
});
