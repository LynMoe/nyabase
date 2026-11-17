import { describe, expect, it } from 'vitest';
import {
  CONTAINER_SCRIPT_MAX_SCRIPT_BYTES,
  containerScriptPathIssue,
  containerScriptPathProblem,
  containerScriptScopeMatches,
  zContainerScriptScope,
  zCreateContainerScriptRequest,
  zPublishContainerScriptRequest,
} from '../index.js';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('container script install paths', () => {
  it('accepts absolute file paths outside the forbidden trees', () => {
    expect(containerScriptPathIssue('/etc/apt/sources.list.d/mirror.list')).toBeNull();
    expect(containerScriptPathIssue('/procfs-is-fine')).toBeNull();
  });

  it('names what is wrong, with the forbidden prefix', () => {
    expect(containerScriptPathIssue('etc/x')).toEqual({ code: 'not_absolute' });
    expect(containerScriptPathIssue('/etc/')).toEqual({ code: 'directory' });
    expect(containerScriptPathIssue('/etc//x')).toEqual({ code: 'empty_segment' });
    expect(containerScriptPathIssue('/etc/../x')).toEqual({ code: 'dot_segment' });
    expect(containerScriptPathIssue('/etc/x\ny')).toEqual({ code: 'control_characters' });
    expect(containerScriptPathIssue(`/${'a'.repeat(1_024)}`)).toEqual({ code: 'too_long' });
    expect(containerScriptPathIssue('/proc/sys/x')).toEqual({ code: 'forbidden_prefix', prefix: '/proc' });
    expect(containerScriptPathIssue('/var/lib/nyabase/script-runs/x')).toEqual({
      code: 'forbidden_prefix',
      prefix: '/var/lib/nyabase/script-runs',
    });
    expect(containerScriptPathProblem('/dev/null')).toBe('may not be under /dev');
  });
});

describe('container script scope', () => {
  const container = { id: ID(1), serverId: ID(2), imageId: ID(3), ownerId: ID(4) };

  it('needs all or at least one filter, not both', () => {
    expect(zContainerScriptScope.safeParse({}).success).toBe(false);
    expect(zContainerScriptScope.safeParse({ all: true, serverIds: [ID(2)] }).success).toBe(false);
    expect(zContainerScriptScope.parse({ serverIds: [ID(9), ID(2), ID(2)] }).serverIds).toEqual([ID(2), ID(9)]);
  });

  it('matches when every non-empty list contains the container, never when excluded', () => {
    const scope = (input: object) => zContainerScriptScope.parse(input);
    expect(containerScriptScopeMatches(scope({ all: true }), container)).toBe(true);
    expect(containerScriptScopeMatches(scope({ all: true, excludeContainerIds: [ID(1)] }), container)).toBe(false);
    expect(containerScriptScopeMatches(scope({ serverIds: [ID(2)], ownerIds: [ID(4)] }), container)).toBe(true);
    expect(containerScriptScopeMatches(scope({ serverIds: [ID(2)], ownerIds: [ID(5)] }), container)).toBe(false);
    expect(containerScriptScopeMatches(scope({ containerIds: [ID(1)] }), container)).toBe(true);
  });
});

describe('container script requests', () => {
  const base = { name: ' tasksmax ', script: '#!/bin/sh\ntrue\n', scope: { all: true } };

  it('fills defaults and trims the name', () => {
    expect(zCreateContainerScriptRequest.parse(base)).toMatchObject({
      name: 'tasksmax',
      everyBoot: false,
      applyNow: true,
      onNewContainers: false,
      stoppedPolicy: 'wait',
      timeoutSeconds: 600,
      maxAttempts: 3,
      pauseAfterFailures: 3,
      canaryCount: null,
      files: [],
    });
  });

  it('refuses scripts without a #! line, oversized scripts, duplicate files and bad modes', () => {
    expect(zCreateContainerScriptRequest.safeParse({ ...base, script: 'echo hi' }).success).toBe(false);
    expect(zCreateContainerScriptRequest.safeParse({ ...base, script: `#!/bin/sh\n${'x'.repeat(CONTAINER_SCRIPT_MAX_SCRIPT_BYTES)}` }).success).toBe(false);
    const file = { name: 'a', sha256: 'a'.repeat(64), destination: { path: '/etc/a' } };
    expect(zCreateContainerScriptRequest.safeParse({ ...base, files: [file, file] }).success).toBe(false);
    expect(zCreateContainerScriptRequest.parse({ ...base, files: [file] }).files[0]!.destination).toEqual({
      path: '/etc/a',
      mode: '0644',
      owner: 'root',
    });
    expect(zCreateContainerScriptRequest.safeParse({
      ...base,
      files: [{ ...file, destination: { path: '/etc/a', mode: '999' } }],
    }).success).toBe(false);
    expect(zPublishContainerScriptRequest.safeParse({ ...base, name: undefined, expectedRevision: 1 }).success).toBe(false);
    expect(zPublishContainerScriptRequest.parse({ script: base.script, scope: base.scope, expectedRevision: 1 }).applyNow).toBe(true);
  });
});
