import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

type ApiErrorBody = { message?: unknown; error?: unknown; statusCode?: unknown };

class ApiError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${method} ${path} failed with ${status}: ${JSON.stringify(body)}`);
  }
}

type LoginResponse = {
  accessToken: string;
  user: { id: string; username: string; capabilities: string[] };
};

type ServerDto = {
  id: string;
  name: string;
  status: string;
  gpus?: Array<{ index: number }>;
};

type ServerManifest = Pick<ServerDto, 'id' | 'name' | 'status'> & { gpuCount: number };

type DataDiskDto = {
  diskId: string;
  mountPoint: string;
  label?: string;
  pquotaEnabled: boolean;
};

type RemoteFsMountDto = {
  id: string;
  name: string;
  displayName?: string | null;
  serverIds?: string[];
};

type UserDto = {
  id: string;
  username: string;
  capabilities: string[];
};

type ImageDto = {
  id: string;
  name: string;
  dockerImage: string;
  isActive: boolean;
};

type ImageManifest = Pick<ImageDto, 'id' | 'name' | 'dockerImage' | 'isActive'>;

type EffectiveAccess = {
  servers: Array<{
    serverId: string;
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    gpuMode: 'none' | 'indices' | 'all';
    gpuIndices: number[];
    allowedImageIds: string[];
  }>;
};

type Persona = 'alpha' | 'beta' | 'gamma' | 'delta' | 'epsilon';

type PersonaSpec = {
  persona: Persona;
  serverGrants: Array<{
    label: 'cpu' | 'gpu';
    cpuMillis: number;
    memBytes: number;
    diskBytes: number;
    gpuMode: 'none' | 'indices';
    gpuIndices?: number[];
  }>;
  imageGrants: Array<'cpuA' | 'cpuB' | 'gpuA' | 'inactive'>;
  mountGrants: Array<'local' | 'remote'>;
};

type SetupState = {
  runId: string;
  runPrefix: string;
  backendUrl: string;
  tempDir: string;
  createdAt: string;
  status: 'pass' | 'blocked-infra';
  servers: {
    cpu: ServerDto;
    gpu: ServerDto | null;
    gpuSetup: 'available' | 'blocked-infra';
    gpuGap?: string;
  };
  images: Record<string, ImageDto | null>;
  sources: {
    local: { kind: 'local'; id: string; serverId: string; mountPoint: string } | null;
    remote: { kind: 'remote'; id: string; serverIds: string[]; name: string } | null;
    gaps: string[];
  };
  users: Record<
    Persona,
    {
      id: string;
      username: string;
      credentialFile: string;
      capabilities: string[];
      effectiveAccess: EffectiveAccess;
    }
  >;
  grants: Record<Persona, { serverGrants: string[]; imageGrants: string[]; mountSourceGrants: string[] }>;
  setupGaps: string[];
};

const SESSION_TESTS =
  '.codex/skills/harness/docs/multi-user-redteam/20260602T035546Z/tests.md';

const MANAGEMENT_CAPS = new Set([
  'manage_users',
  'manage_groups',
  'manage_servers',
  'manage_images',
  'manage_grants',
  'manage_containers_any',
  'view_audit',
  'view_metrics_all',
]);

const MI_B = 1024 * 1024;

const env = await loadTestEnv();
const apiBase = stripTrailingSlash(
  process.env.NYABASE_BACKEND_URL ?? process.env.BACKEND_URL ?? `http://localhost:${env.PORT ?? '3001'}`,
) + '/api';
const adminUsername = process.env.ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.ADMIN_INIT_PASSWORD ?? env.ADMIN_INIT_PASSWORD;

if (!adminPassword) {
  throw new Error('ADMIN_INIT_PASSWORD must be set in test/config/local.env or process env');
}

describe('multi-user red-team admin fixture setup', () => {
  it('creates admin-only live fixtures and non-secret setup manifest', async () => {
    const runSeed = process.env.NYABASE_MURT_RUN_ID ?? timestampRunId();
    const runId = runSeed.startsWith('murt-') ? runSeed.slice('murt-'.length) : runSeed;
    const runPrefix = `murt-${runId}`;
    const tempDir = process.env.NYABASE_MURT_COORD_DIR ?? join('test/runtime/murt', runId);
    const setupGaps: string[] = [];

    await mkdir(tempDir, { recursive: true, mode: 0o700 });

    const admin = await login(adminUsername, adminPassword);
    expect(admin.user.capabilities).toEqual(expect.arrayContaining(Array.from(MANAGEMENT_CAPS)));

    const servers = await api<ServerDto[]>('GET', '/admin/servers', admin.accessToken);
    const cpu = servers.find((s) => s.status === 'online' && !hasGpu(s));
    const gpu = servers.find((s) => s.status === 'online' && hasGpu(s)) ?? null;
    expect(cpu, 'expected one online CPU server from product API').toBeTruthy();

    const gpuSetup = gpu ? 'available' : 'blocked-infra';
    if (!gpu) setupGaps.push('blocked-infra: no online GPU server returned by GET /api/servers');

    const [localSource, remoteSource] = await discoverSources(admin.accessToken, cpu!.id, setupGaps);

    const images = await createImages(admin.accessToken, runPrefix, gpu !== null);
    const users = await createPersonaUsers(admin.accessToken, runPrefix, tempDir);

    const personas: PersonaSpec[] = [
      {
        persona: 'alpha',
        serverGrants: [{ label: 'cpu', cpuMillis: 500, memBytes: 256 * MI_B, diskBytes: 64 * MI_B, gpuMode: 'none' }],
        imageGrants: ['cpuA'],
        mountGrants: ['local'],
      },
      {
        persona: 'beta',
        serverGrants: [{ label: 'cpu', cpuMillis: 1000, memBytes: 512 * MI_B, diskBytes: 128 * MI_B, gpuMode: 'none' }],
        imageGrants: ['cpuB'],
        mountGrants: ['remote'],
      },
      {
        persona: 'gamma',
        serverGrants: gpu
          ? [{ label: 'gpu', cpuMillis: 1000, memBytes: 1024 * MI_B, diskBytes: 256 * MI_B, gpuMode: 'indices', gpuIndices: [0] }]
          : [],
        imageGrants: gpu ? ['gpuA'] : [],
        mountGrants: [],
      },
      {
        persona: 'delta',
        serverGrants: [
          { label: 'cpu', cpuMillis: 1500, memBytes: 1024 * MI_B, diskBytes: 256 * MI_B, gpuMode: 'none' },
          ...(gpu
            ? [{ label: 'gpu' as const, cpuMillis: 1000, memBytes: 1024 * MI_B, diskBytes: 256 * MI_B, gpuMode: 'indices' as const, gpuIndices: [1] }]
            : []),
        ],
        imageGrants: gpu ? ['cpuA', 'gpuA'] : ['cpuA'],
        mountGrants: ['local', 'remote'],
      },
      {
        persona: 'epsilon',
        serverGrants: [],
        imageGrants: ['inactive'],
        mountGrants: [],
      },
    ];

    const grants: SetupState['grants'] = {
      alpha: { serverGrants: [], imageGrants: [], mountSourceGrants: [] },
      beta: { serverGrants: [], imageGrants: [], mountSourceGrants: [] },
      gamma: { serverGrants: [], imageGrants: [], mountSourceGrants: [] },
      delta: { serverGrants: [], imageGrants: [], mountSourceGrants: [] },
      epsilon: { serverGrants: [], imageGrants: [], mountSourceGrants: [] },
    };

    for (const spec of personas) {
      const user = users[spec.persona];
      for (const grant of spec.serverGrants) {
        const serverId = grant.label === 'cpu' ? cpu!.id : gpu!.id;
        await api('POST', `/admin/users/${user.id}/server-grants/${serverId}`, admin.accessToken, {
          cpuMillis: grant.cpuMillis,
          memBytes: grant.memBytes,
          diskBytes: grant.diskBytes,
          gpuMode: grant.gpuMode,
          gpuIndices: grant.gpuIndices ?? [],
        });
        grants[spec.persona].serverGrants.push(`${grant.label}:${serverId}`);
      }

      for (const imageKey of spec.imageGrants) {
        const image = images[imageKey];
        if (!image) continue;
        const serverId = imageKey === 'gpuA' ? gpu!.id : cpu!.id;
        await api('POST', `/admin/users/${user.id}/image-grants`, admin.accessToken, {
          imageId: image.id,
          serverId,
        });
        grants[spec.persona].imageGrants.push(`${imageKey}:${image.id}@${serverId}`);
      }

      for (const mount of spec.mountGrants) {
        if (mount === 'local') {
          if (!localSource) {
            setupGaps.push(`setup-gap: local source unavailable for ${spec.persona}`);
            continue;
          }
          await grantMountSource(admin.accessToken, user.id, 'local', localSource.id);
          grants[spec.persona].mountSourceGrants.push(`local:${localSource.id}`);
        } else {
          if (!remoteSource) {
            setupGaps.push(`setup-gap: remote source unavailable for ${spec.persona}`);
            continue;
          }
          await grantMountSource(admin.accessToken, user.id, 'remote', remoteSource.id);
          grants[spec.persona].mountSourceGrants.push(`remote:${remoteSource.id}`);
        }
      }
    }

    const stateUsers = {} as SetupState['users'];
    for (const persona of Object.keys(users) as Persona[]) {
      const user = users[persona];
      const effectiveAccess = await api<EffectiveAccess>('GET', `/admin/users/${user.id}/effective-access`, admin.accessToken);
      const loginResult = await login(user.username, user.password);

      expect(loginResult.user.id).toBe(user.id);
      expect(loginResult.user.capabilities.filter((cap) => MANAGEMENT_CAPS.has(cap))).toEqual([]);
      expect(sortEffectiveAccess(effectiveAccess.servers)).toEqual(sortEffectiveAccess(expectedEffectiveAccess(persona, cpu!.id, gpu?.id, images)));

      stateUsers[persona] = {
        id: user.id,
        username: user.username,
        credentialFile: user.credentialFile,
        capabilities: loginResult.user.capabilities,
        effectiveAccess,
      };
    }

    expect(Object.keys(stateUsers).sort()).toEqual(['alpha', 'beta', 'delta', 'epsilon', 'gamma']);

    const state: SetupState = {
      runId,
      runPrefix,
      backendUrl: apiBase.slice(0, -'/api'.length),
      tempDir,
      createdAt: new Date().toISOString(),
      status: gpu ? 'pass' : 'blocked-infra',
      servers: {
        cpu: serverManifest(cpu!),
        gpu: gpu ? serverManifest(gpu) : null,
        gpuSetup,
        ...(gpu ? {} : { gpuGap: 'No online GPU server returned by GET /api/servers' }),
      },
      images: {
        cpuA: imageManifest(images.cpuA),
        cpuB: imageManifest(images.cpuB),
        inactive: imageManifest(images.inactive),
        gpuA: images.gpuA ? imageManifest(images.gpuA) : null,
      },
      sources: {
        local: localSource,
        remote: remoteSource,
        gaps: setupGaps.filter((gap) => gap.includes('source') || gap.includes('mount')),
      },
      users: stateUsers,
      grants,
      setupGaps: unique(setupGaps),
    };

    const statePath = join(tempDir, 'state.json');
    await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await appendTestsMd(state, statePath);

    expect(await readFile(statePath, 'utf8')).not.toMatch(/accessToken|refreshToken|ADMIN_INIT_PASSWORD|admin123|password":/);
  }, 120_000);
});

async function loadTestEnv() {
  const text = await readFile('test/config/local.env', 'utf8');
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const eq = line.indexOf('=');
        return eq === -1 ? [line, ''] : [line.slice(0, eq), line.slice(eq + 1)];
      }),
  ) as Record<string, string>;
}

async function login(username: string, password: string): Promise<LoginResponse> {
  return api<LoginResponse>('POST', '/auth/login', undefined, { username, password });
}

async function api<T = unknown>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;

  const contentType = res.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(method, path, res.status, data as ApiErrorBody);
  return data as T;
}

async function discoverSources(token: string, cpuServerId: string, gaps: string[]) {
  const disks = await api<DataDiskDto[]>('GET', `/admin/servers/${cpuServerId}/disks`, token);
  const local = disks.find((disk) => disk.pquotaEnabled) ?? disks[0] ?? null;
  if (!local) gaps.push(`setup-gap: no local data disk source returned for CPU server ${cpuServerId}`);

  const remotes = await api<RemoteFsMountDto[]>('GET', `/admin/remote-fs-mounts?serverId=${encodeURIComponent(cpuServerId)}`, token);
  const remote = remotes[0] ?? null;
  if (!remote) gaps.push(`setup-gap: no remote FS mount assigned to CPU server ${cpuServerId}`);

  return [
    local ? { kind: 'local' as const, id: local.diskId, serverId: cpuServerId, mountPoint: local.mountPoint } : null,
    remote ? { kind: 'remote' as const, id: remote.id, serverIds: remote.serverIds ?? [cpuServerId], name: remote.name } : null,
  ] as const;
}

async function createImages(token: string, runPrefix: string, includeGpu: boolean) {
  const cpuA = await createImage(token, runPrefix, 'cpu-a', 'ubuntu:24.04', true);
  const cpuB = await createImage(token, runPrefix, 'cpu-b-same-ref', 'ubuntu:24.04', true);
  const inactive = await createImage(token, runPrefix, 'inactive', 'ubuntu:24.04', false);
  const gpuA = includeGpu ? await createImage(token, runPrefix, 'gpu-a', 'ubuntu:24.04', true) : null;
  return { cpuA, cpuB, inactive, gpuA };
}

async function createImage(
  token: string,
  runPrefix: string,
  label: string,
  dockerImage: string,
  active: boolean,
): Promise<ImageDto> {
  const image = await api<ImageDto>('POST', '/admin/images', token, {
    name: `${runPrefix}-${label}`,
    dockerImage,
    runtimeOverrides: {
      uid: 0,
      entrypoint: null,
      cmd: ['sleep', 'infinity'],
      init: true,
    },
    description: `${runPrefix} disposable red-team setup image ${label}`,
  });
  if (!active) {
    return api<ImageDto>('PATCH', `/admin/images/${image.id}`, token, { isActive: false });
  }
  return image;
}

async function createPersonaUsers(token: string, runPrefix: string, tempDir: string) {
  const result = {} as Record<Persona, UserDto & { password: string; credentialFile: string }>;
  for (const persona of ['alpha', 'beta', 'gamma', 'delta', 'epsilon'] as Persona[]) {
    const username = `${runPrefix}-${persona}`;
    const password = `Murt-${persona}-${randomBytes(18).toString('base64url')}1a`;
    const user = await api<UserDto>('POST', '/admin/users', token, {
      username,
      password,
      displayName: `MURT ${persona}`,
    });
    const credentialFile = join(tempDir, `${persona}.env`);
    await writeFile(credentialFile, `NYABASE_USERNAME=${username}\nNYABASE_PASSWORD=${password}\n`, { mode: 0o600 });
    result[persona] = { ...user, password, credentialFile };
  }
  return result;
}

function sortEffectiveAccess(rows: EffectiveAccess['servers']) {
  return [...rows].sort((a, b) => a.serverId.localeCompare(b.serverId));
}

async function grantMountSource(token: string, userId: string, sourceKind: 'local' | 'remote', sourceId: string) {
  await api('POST', `/admin/users/${userId}/mount-source-grants`, token, { sourceKind, sourceId });
}

function expectedEffectiveAccess(
  persona: Persona,
  cpuServerId: string,
  gpuServerId: string | undefined,
  images: Record<'cpuA' | 'cpuB' | 'inactive' | 'gpuA', ImageDto | null>,
) {
  const cpuA = images.cpuA!.id;
  const cpuB = images.cpuB!.id;
  const inactive = images.inactive!.id;
  const gpuA = images.gpuA?.id;

  const rows: Record<Persona, EffectiveAccess['servers']> = {
    alpha: [{ serverId: cpuServerId, cpuMillis: 500, memBytes: 256 * MI_B, diskBytes: 64 * MI_B, gpuMode: 'none', gpuIndices: [], allowedImageIds: [cpuA] }],
    beta: [{ serverId: cpuServerId, cpuMillis: 1000, memBytes: 512 * MI_B, diskBytes: 128 * MI_B, gpuMode: 'none', gpuIndices: [], allowedImageIds: [cpuB] }],
    gamma: gpuServerId && gpuA
      ? [{ serverId: gpuServerId, cpuMillis: 1000, memBytes: 1024 * MI_B, diskBytes: 256 * MI_B, gpuMode: 'indices', gpuIndices: [0], allowedImageIds: [gpuA] }]
      : [],
    delta: [
      { serverId: cpuServerId, cpuMillis: 1500, memBytes: 1024 * MI_B, diskBytes: 256 * MI_B, gpuMode: 'none', gpuIndices: [], allowedImageIds: [cpuA] },
      ...(gpuServerId && gpuA
        ? [{ serverId: gpuServerId, cpuMillis: 1000, memBytes: 1024 * MI_B, diskBytes: 256 * MI_B, gpuMode: 'indices' as const, gpuIndices: [1], allowedImageIds: [gpuA] }]
        : []),
    ],
    epsilon: [],
  };

  if (persona === 'epsilon') {
    return rows[persona];
  }

  return rows[persona].map((row) => ({
    ...row,
    allowedImageIds: row.allowedImageIds.includes(inactive) ? row.allowedImageIds : row.allowedImageIds,
  }));
}

async function appendTestsMd(state: SetupState, statePath: string) {
  const userRows = (Object.keys(state.users) as Persona[])
    .map((p) => {
      const user = state.users[p];
      const servers = user.effectiveAccess.servers.map((s) => `${s.serverId}:${s.cpuMillis}/${s.memBytes}/${s.diskBytes}/${s.gpuMode}[${s.gpuIndices.join(',')}]`).join('; ') || 'none';
      return `| ${p} | ${user.username} | ${user.id} | ${servers} | ${state.grants[p].imageGrants.join(', ') || 'none'} | ${user.effectiveAccess.servers.flatMap((s) => s.allowedImageIds).join(', ') || 'none'} | ${state.grants[p].mountSourceGrants.join(', ') || 'none'} |`;
    })
    .join('\n');

  const section = `

## Admin Fixture Setup

Prepared: \`${state.createdAt}\`
Run ID: \`${state.runPrefix}\`
Command: \`pnpm exec vitest run test/specs/live/multi-user-redteam-admin-setup.spec.ts\`
Backend URL: \`${state.backendUrl}\`
Temp directory: \`${state.tempDir}\`
State manifest: \`${statePath}\`
Classification: \`${state.setupGaps.some((gap) => gap.includes('blocked-infra')) ? 'blocked-infra-partial' : 'pass'}\`

Admin setup logged in with \`ADMIN_INIT_PASSWORD\` from \`test/config/local.env\`; no admin password, raw JWT, refresh token, API token secret, user password, or agent token is recorded in this session document. Per-user credential files are under the temp directory and contain only that user credential pair.

### Fixture IDs

| Type | Label | ID / value |
| --- | --- | --- |
| server | cpu | ${state.servers.cpu.id} |
| server | gpu | ${state.servers.gpu?.id ?? 'blocked-infra'} |
| image | cpu-a | ${state.images.cpuA?.id ?? 'n/a'} |
| image | cpu-b-same-ref | ${state.images.cpuB?.id ?? 'n/a'} |
| image | inactive | ${state.images.inactive?.id ?? 'n/a'} |
| image | gpu-a | ${state.images.gpuA?.id ?? 'blocked-infra'} |
| source | cpu-local | ${state.sources.local?.id ?? 'setup-gap'} |
| source | cpu-remote | ${state.sources.remote?.id ?? 'setup-gap'} |

### Grants Summary

| Persona | Username | User ID | Server grants | Direct image grants | Effective active images | Mount-source grants |
| --- | --- | --- | --- | --- | --- | --- |
${userRows}

Setup gaps: ${state.setupGaps.length > 0 ? state.setupGaps.map((gap) => `\`${gap}\``).join('; ') : 'none'}.

Cleanup warning: these are live disposable product rows and runtime credential files. Later cleanup must use the exact run prefix \`${state.runPrefix}\` and manifest \`${statePath}\`; do not perform broad cleanup of unrelated resources.
`;

  await writeFile(SESSION_TESTS, (await readFile(SESSION_TESTS, 'utf8')) + section);
}

function timestampRunId() {
  return `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').toLowerCase()}-${randomBytes(3).toString('hex')}`;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function serverManifest(server: ServerDto): ServerManifest {
  return {
    id: server.id,
    name: server.name,
    status: server.status,
    gpuCount: server.gpus?.length ?? 0,
  };
}

function hasGpu(server: ServerDto): boolean {
  return (server.gpus?.length ?? 0) > 0;
}

function imageManifest(image: ImageDto): ImageManifest {
  return {
    id: image.id,
    name: image.name,
    dockerImage: image.dockerImage,
    isActive: image.isActive,
  };
}
