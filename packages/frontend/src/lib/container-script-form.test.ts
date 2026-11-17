import { describe, expect, it } from 'vitest';
import {
  CONTAINER_SCRIPT_MAX_FILES,
  CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES,
  ContainerScriptFileOwner,
  ContainerScriptStoppedPolicy,
  type ContainerScriptVersionDto,
} from '@nyabase/common';
import {
  confirmLines,
  createRequestFromForm,
  DEFAULT_SCRIPT_BODY,
  emptyScriptForm,
  installPathProblem,
  newFileRowKey,
  publishRequestFromForm,
  sanitizeFileName,
  scriptFormFromVersion,
  scriptPatchFromEdit,
  uniqueFileName,
  type ScriptFileRow,
  type ScriptForm,
} from './container-script-form.js';

const SHA = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SERVER = '11111111-1111-4111-8111-111111111111';
const CONTAINER = '22222222-2222-4222-8222-222222222222';

function form(overrides: Partial<ScriptForm> = {}): ScriptForm {
  return { ...emptyScriptForm(), name: 'apt mirror', ...overrides };
}

function fileRow(overrides: Partial<ScriptFileRow> = {}): ScriptFileRow {
  return {
    key: newFileRowKey(),
    name: 'sources.list',
    sha256: SHA,
    sizeBytes: 100,
    uploading: false,
    uploadError: null,
    path: '',
    mode: '0644',
    owner: ContainerScriptFileOwner.Root,
    ...overrides,
  };
}

function version(overrides: Partial<ContainerScriptVersionDto> = {}): ContainerScriptVersionDto {
  return {
    version: 3,
    script: '#!/bin/sh\necho hi\n',
    files: [{ name: 'motd', sha256: SHA_B, sizeBytes: 12, destination: { path: '/etc/motd', mode: '0600', owner: 'login_user' } }],
    scope: { all: false, serverIds: [SERVER], imageIds: [], ownerIds: [], containerIds: [], excludeContainerIds: [CONTAINER] },
    onNewContainers: true,
    applyNow: false,
    stoppedPolicy: ContainerScriptStoppedPolicy.Skip,
    timeoutSeconds: 120,
    maxAttempts: 2,
    maxParallel: 4,
    maxParallelPerServer: null,
    canaryCount: 5,
    pauseAfterFailures: null,
    note: 'v3',
    publishedAt: '2026-11-17T00:00:00.000Z',
    publishedBy: null,
    ...overrides,
  };
}

describe('file names', () => {
  it('sanitizes a picked file name to the allowed characters', () => {
    expect(sanitizeFileName('id_rsa.pub')).toBe('id_rsa.pub');
    expect(sanitizeFileName('my config (1).yaml')).toBe('my_config_1_.yaml');
    expect(sanitizeFileName('.bashrc')).toBe('bashrc');
    expect(sanitizeFileName('配置.conf')).toBe('conf');
    expect(sanitizeFileName('C:\\Users\\a\\x.txt')).toBe('x.txt');
    expect(sanitizeFileName('___')).toBe('file');
    expect(sanitizeFileName('x'.repeat(300))).toHaveLength(128);
  });

  it('suffixes a taken name before its extension', () => {
    expect(uniqueFileName('a.txt', new Set())).toBe('a.txt');
    expect(uniqueFileName('a.txt', new Set(['a.txt']))).toBe('a-2.txt');
    expect(uniqueFileName('a.txt', new Set(['a.txt', 'a-2.txt']))).toBe('a-3.txt');
    expect(uniqueFileName('Makefile', new Set(['Makefile']))).toBe('Makefile-2');
  });

  it('explains install path problems in Chinese', () => {
    expect(installPathProblem('/etc/motd')).toBeNull();
    expect(installPathProblem('etc/motd')).toContain('绝对路径');
    expect(installPathProblem('/etc/')).toContain('不能以 / 结尾');
    expect(installPathProblem('/proc/x')).toBe('不能安装到 /proc 下');
    expect(installPathProblem('/var/lib/nyabase/script-runs/x')).toContain('/var/lib/nyabase/script-runs');
    expect(installPathProblem('/a/../b')).toContain('..');
  });
});

describe('createRequestFromForm', () => {
  it('maps the defaults: all containers, 立即 + 新容器, 600 s, 3 attempts, pause after 3', () => {
    const result = createRequestFromForm(form());
    expect(result.errors).toBeNull();
    expect(result.body).toEqual({
      name: 'apt mirror',
      description: '',
      everyBoot: false,
      script: DEFAULT_SCRIPT_BODY,
      files: [],
      scope: { all: true, serverIds: [], imageIds: [], ownerIds: [], containerIds: [], excludeContainerIds: [] },
      onNewContainers: true,
      applyNow: true,
      stoppedPolicy: 'wait',
      timeoutSeconds: 600,
      maxAttempts: 3,
      maxParallel: null,
      maxParallelPerServer: null,
      canaryCount: null,
      pauseAfterFailures: 3,
      note: '',
    });
    expect(result.body).not.toHaveProperty('priority');
  });

  it('sends a typed priority, blank limits as null, and files with their destination', () => {
    const result = createRequestFromForm(form({
      priority: '20',
      pauseAfterFailures: '',
      canaryCount: '2',
      files: [fileRow({ path: '/etc/apt/sources.list', mode: '644', owner: ContainerScriptFileOwner.LoginUser }), fileRow({ name: 'b', sha256: SHA_B })],
    }));
    expect(result.body).toMatchObject({
      priority: 20,
      pauseAfterFailures: null,
      canaryCount: 2,
      files: [
        { name: 'sources.list', sha256: SHA, destination: { path: '/etc/apt/sources.list', mode: '0644', owner: 'login_user' } },
        { name: 'b', sha256: SHA_B, destination: null },
      ],
    });
  });

  it('turns 新容器 on for 每次开机 and drops the 停机容器 choice where it does not apply', () => {
    const boot = createRequestFromForm(form({ everyBoot: true, onNewContainers: false, stoppedPolicy: ContainerScriptStoppedPolicy.Skip }));
    expect(boot.body).toMatchObject({ everyBoot: true, onNewContainers: true, stoppedPolicy: 'wait' });
    const later = createRequestFromForm(form({ applyNow: false, stoppedPolicy: ContainerScriptStoppedPolicy.Skip }));
    expect(later.body).toMatchObject({ applyNow: false, stoppedPolicy: 'wait' });
    const skip = createRequestFromForm(form({ stoppedPolicy: ContainerScriptStoppedPolicy.Skip }));
    expect(skip.body).toMatchObject({ applyNow: true, stoppedPolicy: 'skip' });
  });

  it('keeps only the filters of a filtered scope, and the exclusions of an all scope', () => {
    const filtered = createRequestFromForm(form({ scopeAll: false, serverIds: [SERVER], excludeContainerIds: [CONTAINER] }));
    expect(filtered.body?.scope).toEqual({
      all: false, serverIds: [SERVER], imageIds: [], ownerIds: [], containerIds: [], excludeContainerIds: [CONTAINER],
    });
    const all = createRequestFromForm(form({ scopeAll: true, serverIds: [SERVER], excludeContainerIds: [CONTAINER] }));
    expect(all.body?.scope).toMatchObject({ all: true, serverIds: [], excludeContainerIds: [CONTAINER] });
  });

  it('reports what blocks the request', () => {
    const result = createRequestFromForm(form({
      name: ' ',
      priority: '0',
      applyNow: false,
      onNewContainers: false,
      scopeAll: false,
      script: 'echo hi',
      timeoutSeconds: '5',
      maxAttempts: '',
      maxParallelPerServer: '101',
    }));
    expect(result.body).toBeNull();
    expect(result.errors?.fields).toMatchObject({
      name: '请填写名称',
      priority: expect.stringContaining('1–1000000'),
      triggers: '至少选择一种触发方式',
      scope: expect.stringContaining('至少一个筛选条件'),
      script: expect.stringContaining('#!'),
      timeoutSeconds: expect.stringContaining('10–86400'),
      maxAttempts: '请填写',
      maxParallelPerServer: expect.stringContaining('1–100'),
    });
  });

  it('lets a new version go without triggers (it replaces the old one for unfinished containers)', () => {
    const form = { ...emptyScriptForm(), scopeAll: true, applyNow: false, onNewContainers: false };
    expect(publishRequestFromForm(form, 3).body).toMatchObject({ expectedRevision: 3, applyNow: false, onNewContainers: false });
    expect(createRequestFromForm({ ...form, name: 'x' }).errors?.fields.triggers).toBe('至少选择一种触发方式');
  });

  it('checks every file row and the file limits', () => {
    const uploading = fileRow({ sha256: null, uploading: true });
    const failed = fileRow({ name: 'x', sha256: null, uploadError: '上传失败' });
    const duplicate = fileRow();
    const badPath = fileRow({ name: 'c', path: '/sys/x' });
    const badMode = fileRow({ name: 'd', path: '/etc/d', mode: '0999' });
    const first = fileRow({ name: 'e', path: '/etc/e' });
    const samePath = fileRow({ name: 'f', path: '/etc/e' });
    const result = createRequestFromForm(form({ files: [fileRow(), uploading, failed, duplicate, badPath, badMode, first, samePath] }));
    expect(result.errors?.files).toEqual({
      [uploading.key]: '文件仍在上传',
      [failed.key]: '上传失败',
      [duplicate.key]: '文件名 sources.list 重复',
      [badPath.key]: '不能安装到 /sys 下',
      [badMode.key]: '权限须为八进制，例如 0644',
      [samePath.key]: '两个文件都安装到 /etc/e',
    });
    const tooMany = Array.from({ length: CONTAINER_SCRIPT_MAX_FILES + 1 }, (_, index) => fileRow({ name: `f${index}`, sizeBytes: 1 }));
    expect(createRequestFromForm(form({ files: tooMany })).errors?.fields.files).toContain(String(CONTAINER_SCRIPT_MAX_FILES));
    const tooBig = [fileRow({ sizeBytes: CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES }), fileRow({ name: 'b', sizeBytes: 1 })];
    expect(createRequestFromForm(form({ files: tooBig })).errors?.fields.files).toContain('合计');
  });
});

describe('publish', () => {
  it('prefills a new version from the current one, files keeping their content', () => {
    const prefilled = scriptFormFromVersion({ name: 's', description: 'd', priority: 30, everyBoot: false }, version());
    expect(prefilled).toMatchObject({
      applyNow: false,
      onNewContainers: true,
      stoppedPolicy: 'skip',
      scopeAll: false,
      serverIds: [SERVER],
      excludeContainerIds: [CONTAINER],
      timeoutSeconds: '120',
      maxAttempts: '2',
      maxParallel: '4',
      maxParallelPerServer: '',
      canaryCount: '5',
      pauseAfterFailures: '',
      note: '',
    });
    expect(prefilled.files).toEqual([expect.objectContaining({
      name: 'motd', sha256: SHA_B, sizeBytes: 12, path: '/etc/motd', mode: '0600', owner: 'login_user', uploading: false,
    })]);
    const result = publishRequestFromForm({ ...prefilled, applyNow: true, note: '修复' }, 7);
    expect(result.body).toMatchObject({
      expectedRevision: 7,
      applyNow: true,
      stoppedPolicy: 'skip',
      note: '修复',
      files: [{ name: 'motd', sha256: SHA_B, destination: { path: '/etc/motd', mode: '0600', owner: 'login_user' } }],
    });
    expect(result.body).not.toHaveProperty('name');
    expect(result.body).not.toHaveProperty('everyBoot');
  });
});

describe('scriptPatchFromEdit', () => {
  const script = { name: 's', description: '', priority: 10, revision: 4 };

  it('sends only what changed, with the revision', () => {
    expect(scriptPatchFromEdit(script, { name: ' t ', description: '', priority: '10' }))
      .toEqual({ body: { expectedRevision: 4, name: 't' }, errors: null });
    expect(scriptPatchFromEdit(script, { name: 's', description: 'x', priority: '20' }))
      .toEqual({ body: { expectedRevision: 4, description: 'x', priority: 20 }, errors: null });
  });

  it('sends nothing when nothing changed, and flags bad input', () => {
    expect(scriptPatchFromEdit(script, { name: 's', description: '', priority: '10' })).toEqual({ body: null, errors: null });
    expect(scriptPatchFromEdit(script, { name: '', description: '', priority: 'x' }).errors)
      .toMatchObject({ name: '请填写名称', priority: expect.stringContaining('整数') });
  });
});

describe('confirmLines', () => {
  const base = {
    everyBoot: false, applyNow: true, onNewContainers: true, stoppedPolicy: ContainerScriptStoppedPolicy.Wait, canaryCount: '',
  };

  it('says how many containers run now and what happens to stopped ones', () => {
    expect(confirmLines(base, { total: 10, running: 7 })).toEqual([
      '范围内现有的 10 个容器都执行此版本：运行中的 7 个立即执行，停机的 3 个开机后执行',
      '之后进入范围的新容器创建后执行一次',
    ]);
    expect(confirmLines({ ...base, stoppedPolicy: ContainerScriptStoppedPolicy.Skip, onNewContainers: false }, { total: 2, running: 1 })[0])
      .toContain('停机的 1 个跳过');
  });

  it('covers every-boot scripts, versions without 立即 and canaries', () => {
    expect(confirmLines({ ...base, everyBoot: true }, { total: 4, running: 3 })).toEqual([
      '运行中的 3 个容器立即执行此版本；其余 1 个下次开机时执行',
      '之后范围内的容器每次开机都会执行',
    ]);
    expect(confirmLines({ ...base, applyNow: false, canaryCount: '2' }, { total: 4, running: 3 })).toEqual([
      '现有容器不因本次发布重新执行；还没成功执行过的容器改用此版本',
      '之后进入范围的新容器创建后执行一次',
      '灰度：2 个容器执行后自动暂停，确认结果后再恢复',
    ]);
  });
});
