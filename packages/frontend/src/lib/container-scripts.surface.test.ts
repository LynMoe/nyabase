import { describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSource, readSourceDir } from './read-source.test-helper.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readSource(root, rel);
const components = () => readSourceDir(root, 'components/container-scripts');

describe('容器脚本 pages', () => {
  it('guards both routes as admin-only and lists the page in the sidebar', () => {
    expect(read('lib/route-access.ts')).toMatch(/containerScripts: Role\.Admin/);
    expect(read('lib/navigation.ts')).toMatch(/to: '\/container-scripts', icon: FileTerminal, label: '容器脚本', access: ACCESS\.containerScripts/);
    for (const route of ['routes/container-scripts/index.tsx', 'routes/container-scripts/$scriptId.tsx']) {
      expect(read(route)).toMatch(/RequireAccess rule=\{ACCESS\.containerScripts\}/);
    }
    expect(read('routes/container-scripts/$scriptId.tsx')).toMatch(/validateSearch: parseContainerScriptSearch/);
    expect(read('routeTree.gen.ts')).toMatch(/'\/container-scripts\/\$scriptId'/);
  });

  it('lists scripts in priority order with triggers, scope, version, status and progress', () => {
    const page = read('pages/container-scripts-page.tsx');
    expect(page).toContain("'/admin/container-scripts'");
    expect(page).toMatch(/left\.priority - right\.priority/);
    expect(page).toMatch(/显示已归档/);
    expect(page).toMatch(/新建脚本/);
    for (const heading of ['优先级', '名称', '触发', '范围', '版本', '状态', '进度']) {
      expect(page).toContain(`>${heading}</TableHead>`);
    }
    expect(page).toMatch(/scopeSummary\(script\.current\.scope\)/);
    expect(page).toMatch(/<CountsSummary counts=\{script\.counts\}/);
  });

  it('creates and publishes with one form: triggers, scope preview, files, advanced, and a confirmation step', () => {
    const form = components();
    for (const label of ['立即', '新容器', '每次开机', '停机容器', '排除容器', '预览范围', '添加文件', '安装路径（可选）', '属主',
      '超时（秒）', '最多尝试次数', '同时执行数（全平台）', '同时执行数（每台服务器）', '灰度台数', '失败自动暂停阈值', '版本说明（可选）']) {
      expect(form).toContain(label);
    }
    expect(form).toContain("'/admin/container-scripts/preview'");
    expect(form).toMatch(/api\.upload<ContainerScriptBlobDto>\(CONTAINER_SCRIPT_BLOB_UPLOAD_PATH, file\)/);
    expect(form).toMatch(/\/admin\/container-scripts\/\$\{id\}\/versions/);
    expect(form).toMatch(/disabled=\{form\.everyBoot\}/);
    expect(form).toMatch(/disabled=\{!creating\}/);
    expect(form).toMatch(/placeholder="默认排在最后"/);
    expect(form).toMatch(/state\.confirming \? <ConfirmView/);
    expect(read('lib/container-script-form.ts')).toMatch(/zCreateContainerScriptRequest\.safeParse/);
    expect(read('lib/container-script-form.ts')).toMatch(/zPublishContainerScriptRequest\.safeParse/);
  });

  it('downloads file contents with the session and never re-uploads a published file', () => {
    expect(components()).toMatch(/api\.getBlob\(`\/admin\/container-scripts\/blobs\/\$\{file\.sha256\}`\)/);
    expect(read('lib/api.ts')).toMatch(/upload: <T>\(path: string, body: Blob/);
    expect(read('lib/container-script-form.ts')).toMatch(/sha256: file\.sha256,\n\s+sizeBytes: file\.sizeBytes/);
  });

  it('shows a script with its actions, paused banner and four tabs', () => {
    const page = read('pages/container-script-detail-page.tsx');
    for (const label of ['发布新版本', '编辑', '暂停', '恢复', '重试全部失败', '归档', '容器', '执行记录', '版本', '当前脚本']) {
      expect(page).toContain(label);
    }
    expect(page).toMatch(/expectedRevision: script\.revision/);
    expect(page).toMatch(/<ConfirmDialog/);
    expect(page).toMatch(/<PausedBanner script=\{loaded\} \/>/);
    expect(page).toMatch(/scriptInProgress\(query\.state\.data\) \? SCRIPT_IN_PROGRESS_POLL_MS : false/);
    expect(page).toMatch(/\/targets/);
    expect(page).toMatch(/runsPath\(script\.id, \{ containerId, limit: pageSize, before: pages\.cursor \}\)/);
    expect(page).toMatch(/\/admin\/container-scripts\/\$\{scriptId\}\/runs\/\$\{runId\}/);
    expect(page).toMatch(/\/admin\/container-scripts\/\$\{script\.id\}\/versions\/\$\{version\}/);
    expect(page).toMatch(/kind="container" id=\{target\.containerId\}/);
  });

  it('shows the maintenance record on container pages with the page scope', () => {
    expect(read('pages/container-detail-page.tsx')).toMatch(/<ContainerMaintenanceSection containerId=\{container\.id\} scope=\{scope\} \/>/);
    const section = read('components/container-scripts/container-maintenance-section.tsx');
    expect(section).toMatch(/scopedPath\(`\/containers\/\$\{containerId\}\/maintenance`, scope\)/);
    expect(section).toMatch(/if \(items\.length === 0\) return null/);
    expect(section).toMatch(/kind="container-script"/);
    expect(section).not.toMatch(/\.output\b|\.script\b/);
  });

  it('links audit targets and names the new settings', () => {
    expect(read('pages/audit-page/audit-parts.tsx')).toMatch(/container_script: 'container-script'/);
    expect(read('components/refs/resource-ref.tsx')).toMatch(/to="\/container-scripts\/\$scriptId"/);
    const settings = read('pages/system-settings-page/settings-sections.tsx');
    expect(settings).toContain('容器脚本同时执行数（全平台）');
    expect(settings).toContain('容器脚本同时执行数（每台服务器）');
  });
});
