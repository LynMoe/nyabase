// Runs against the freshly started control plane in two phases of `e2e.sh up`:
//   servers  registers every lab server and writes its one-time agent
//            enrollment token to <run dir>/enroll.env (e2e.sh then starts the agents);
//   finish   waits for the agents, registers pools, the IP pool, the shared backend
//            and the image, runs preflight and writes <run dir>/state.json.
// Everything comes from the environment that `e2e.sh` exported from lab.env.
import { execFile } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  PreflightStatus,
  ServerStatus,
  type AdminImageDto,
  type CreateIpPoolRequest,
  type CreateServerRequest,
  type CreatedServerDto,
  type ImageAssignmentDto,
  type IntentAcceptedDto,
  type IpPoolDto,
  type ServerDto,
  type SharedBackendDto,
  type SharedBackendExecutorDiscoverResult,
  type StoragePoolDiscoverResult,
  type StoragePoolDto,
} from '@nyabase/common';
import { login, type Api } from '../client/api.js';
import { pollUntil, waitIntent } from '../client/poll.js';
import type { RunServer, RunState } from '../client/state.js';

const run = promisify(execFile);

function need(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing ${name} (see tests/e2e/lab.env.example)`);
  return value;
}

const opt = (name: string): string => process.env[name]?.trim() ?? '';
const list = (value: string): string[] => value.split(',').map((entry) => entry.trim()).filter(Boolean);

/** Runs `incus ...` on a lab host over ssh (`local` = this machine). */
async function incus(target: string, args: string[]): Promise<string> {
  const [file, argv] = target === 'local'
    ? ['incus', args]
    : ['ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', target, 'incus', ...args]];
  const { stdout } = await run(file as string, argv as string[], { timeout: 60_000 });
  return stdout;
}

const serverIndexes = (): number[] => need('E2E_SERVERS').split(/\s+/).map(Number);
const slugOf = (runId: string, index: number): string => `e2e-${runId}-s${index}`;

/** Phase `servers`: register each server; its agent enrolls with the token written here. */
async function registerServers(api: Api, runId: string, runDir: string): Promise<void> {
  const file = join(runDir, 'enroll.env');
  writeFileSync(file, '', { mode: 0o600 });
  for (const index of serverIndexes()) {
    const prefix = `E2E_SERVER_${index}_`;
    const ssh = need(`${prefix}SSH`);
    const serverName = (JSON.parse(await incus(ssh, ['query', '/1.0'])) as {
      environment?: { server_name?: string };
    }).environment?.server_name ?? slugOf(runId, index);
    const create: CreateServerRequest = {
      name: serverName,
      slug: slugOf(runId, index),
      parentInterface: need(`${prefix}PARENT`),
      dnsServers: list(opt(`${prefix}DNS`)),
      reservedCpus: list(opt(`${prefix}RESERVED_CPUS`)).map(Number),
    };
    const server = await api.post<CreatedServerDto>('/servers', create);
    console.log(`server ${create.slug} registered as ${server.id}`);
    appendFileSync(file, `export ${prefix}ENROLLMENT_TOKEN='${server.enrollment.enrollmentToken}'\n`);
  }
}

async function main(): Promise<void> {
  const phase = process.argv[2];
  const runId = need('E2E_RUN_ID');
  const runDir = need('E2E_RUN_DIR');
  const baseUrl = need('E2E_BASE_URL');
  const admin = { username: 'admin', password: need('E2E_ADMIN_PASSWORD') };
  const { api } = await login(baseUrl, admin.username, admin.password);
  if (phase === 'servers') {
    await registerServers(api, runId, runDir);
    return;
  }
  if (phase !== 'finish') throw new Error('usage: bootstrap.ts servers|finish');

  // 1. Servers: wait for each agent to connect, then register its pools.
  const listed = await api.get<ServerDto[]>('/servers', { scope: 'all' });
  const servers: RunServer[] = [];
  for (const index of serverIndexes()) {
    const prefix = `E2E_SERVER_${index}_`;
    const ssh = need(`${prefix}SSH`);
    const slug = slugOf(runId, index);
    const registered = listed.find((entry) => entry.slug === slug);
    if (!registered) throw new Error(`server ${slug} was not registered`);
    let server = await pollUntil(async () => {
      const current = await api.get<ServerDto>(`/servers/${registered.id}`, { scope: 'all' });
      return current.status === ServerStatus.Online && current.agent.connected && current.cpuTopology
        ? current
        : undefined;
    }, { what: `${slug} agent to connect`, timeoutMs: 90_000 });
    const discovered = await api.post<StoragePoolDiscoverResult>(`/servers/${server.id}/storage-pools/discover`);
    const wanted = need(`${prefix}POOL`);
    const found = discovered.pools.find((pool) => pool.incusName === wanted);
    if (!found) {
      throw new Error(`pool ${wanted} not found on ${slug}; discovered: ${discovered.pools.map((p) => p.incusName).join(', ')}`);
    }
    const pool = await api.patch<StoragePoolDto>(`/servers/${server.id}/storage-pools/${found.id}`, {
      expectedRevision: found.revision,
      registered: true,
    });
    server = await api.get<ServerDto>(`/servers/${server.id}`, { scope: 'all' });
    await api.patch<ServerDto>(`/servers/${server.id}`, {
      expectedRevision: server.revision,
      systemPoolId: pool.id,
    });
    servers.push({
      index,
      id: server.id,
      slug,
      ssh,
      poolId: pool.id,
      poolName: pool.incusName,
      sharedPoolId: null,
      gpuPci: opt(`${prefix}GPU_PCI`) || null,
    });
  }

  // 2. One IP pool bound to every server.
  const ipPool: CreateIpPoolRequest = {
    name: `e2e-${runId}`,
    cidr: need('E2E_IP_CIDR'),
    allocationCidr: need('E2E_IP_ALLOCATION_CIDR'),
    gateway: need('E2E_IP_GATEWAY'),
    reservedIps: list(opt('E2E_IP_RESERVED')),
    serverIds: servers.map((server) => server.id),
  };
  const createdPool = await api.post<IpPoolDto>('/admin/ip-pools', ipPool);

  // 3. Shared backend (optional): map it, then register the executor on each server.
  let sharedBackendId: string | null = null;
  if (opt('E2E_SHARED_IDENTITY_KEY')) {
    const backend = await api.post<SharedBackendDto>('/shared-backends', {
      name: `e2e-${runId}`,
      identityKey: need('E2E_SHARED_IDENTITY_KEY'),
      cephFsid: need('E2E_SHARED_CEPH_FSID'),
      overcommitRatio: Number(opt('E2E_SHARED_OVERCOMMIT') || '1'),
    });
    sharedBackendId = backend.id;
    const discovered = await api.post<SharedBackendExecutorDiscoverResult>(
      `/shared-backends/${backend.id}/executors/discover`,
      {},
    );
    for (const server of servers) {
      const sharedPool = opt(`E2E_SERVER_${server.index}_SHARED_POOL`);
      if (!sharedPool) continue;
      const executor = discovered.executors.find((e) => e.serverId === server.id && e.incusName === sharedPool);
      if (!executor) {
        throw new Error(`no executor ${sharedPool} for ${server.slug}; conflicts: ${JSON.stringify(discovered.identityConflicts)}`);
      }
      await api.patch(`/shared-backends/${backend.id}/executors/${executor.id}`, {
        expectedRevision: executor.revision,
        registered: true,
      });
      server.sharedPoolId = executor.id;
    }
  }

  // 4. Test image, pulled onto every server.
  const image = await api.post<AdminImageDto>('/images', { alias: need('E2E_IMAGE_ALIAS') });
  for (const server of servers) {
    const { intent } = await api.put<{ assignment: ImageAssignmentDto; intent: IntentAcceptedDto }>(
      `/images/${image.id}/assignments/${server.id}`,
      {},
    );
    await waitIntent(api, intent, { timeoutMs: 900_000 });
  }

  // 5. Preflight every server; containers need `passed`.
  for (const server of servers) {
    const current = await api.get<ServerDto>(`/servers/${server.id}`, { scope: 'all' });
    const accepted = await api.post<IntentAcceptedDto>(`/servers/${server.id}/preflight`, {
      expectedServerRevision: current.revision,
      poolId: server.poolId,
      probeAddress: need('E2E_PROBE_ADDRESS'),
    });
    await waitIntent(api, accepted, { timeoutMs: 600_000 });
    const after = await api.get<ServerDto>(`/servers/${server.id}`, { scope: 'all' });
    if (after.preflightStatus !== PreflightStatus.Passed) {
      throw new Error(`preflight on ${server.slug}: ${JSON.stringify(after.preflightReport)}`);
    }
  }

  const host = opt('E2E_LISTEN_HOST') || '127.0.0.1';
  const state: RunState = {
    runId,
    runDir,
    baseUrl,
    databaseUrl: need('E2E_DATABASE_URL'),
    admin,
    sshProxy: { host, port: Number(need('E2E_SSH_PROXY_PORT')) },
    httpProxy: { host, port: Number(need('E2E_HTTP_PROXY_PORT')) },
    servers,
    ipPoolId: createdPool.id,
    image: { id: image.id, alias: image.alias },
    sharedBackendId,
    rootSizeBytes: Number(opt('E2E_ROOT_SIZE_GIB') || '8') * 1024 ** 3,
    probeAddress: need('E2E_PROBE_ADDRESS'),
  };
  writeFileSync(join(runDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  console.log(`state written to ${join(runDir, 'state.json')}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
