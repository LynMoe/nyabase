import type { APIRequestContext, Page } from '@playwright/test';
import { ContainerDeadline } from './container-deadline.js';
import {
  ContainerLease,
  uniqueContainerLeaseName,
  type RunningContainerLease,
} from './container-lease.js';
import { executeThroughConsole, type ConsoleSession } from './console.js';
import type { AgentTaskView, ContainerView } from './durable-api.js';
import { expectJson } from './http.js';
import { requireRuntimeEnv } from './runtime-env.js';
import { aggregateErrorWithDiagnostics } from './error-diagnostics.mjs';
import type { SeedState, SeedServer } from './seed-state.js';

export interface ProductNetworkRuntime {
  lease: ContainerLease;
  task: AgentTaskView;
  view: ContainerView;
  ip: string;
  server: SeedServer;
}

export interface ProductNetworkPoolInput {
  adminApi: APIRequestContext;
  seedState: SeedState;
  label: string;
}

export class ProductNetworkLeasePool {
  private readonly leases: ContainerLease[] = [];
  private sequence = 0;

  constructor(private readonly input: ProductNetworkPoolInput) {}

  async create(
    serverKey: SeedServer['key'],
    deadline: ContainerDeadline,
  ): Promise<ProductNetworkRuntime> {
    const server = this.input.seedState.servers.find((candidate) => candidate.key === serverKey);
    if (!server) throw new Error(`CPU E2E seed has no ${serverKey}`);
    this.sequence += 1;
    const lease = new ContainerLease({
      ownerApi: this.input.adminApi,
      adminApi: this.input.adminApi,
      ownerId: this.input.seedState.adminUserId,
      serverId: server.serverId,
      imageId: this.input.seedState.image.id,
      name: uniqueContainerLeaseName(`${this.input.label}-${serverKey}-${this.sequence}`),
    });
    // Register the lease before crossing the API boundary so cleanup can
    // recover the task/resource even if create fails after committing.
    this.leases.push(lease);
    const created = await lease.createRunning(deadline);
    return this.validateRuntime(lease, created, server);
  }

  async createMany(
    serverKeys: readonly SeedServer['key'][],
    deadline: ContainerDeadline,
  ): Promise<ProductNetworkRuntime[]> {
    const settled = await Promise.allSettled(
      serverKeys.map((serverKey) => this.create(serverKey, deadline)),
    );
    const errors = settled
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw aggregateErrorWithDiagnostics(
        `${this.input.label} failed to create every network lease`,
        errors,
      );
    }
    return settled.map((result) => (result as PromiseFulfilledResult<ProductNetworkRuntime>).value);
  }

  async delete(
    runtime: ProductNetworkRuntime,
    deadline: ContainerDeadline,
  ): Promise<AgentTaskView> {
    const task = await runtime.lease.cleanup(deadline);
    if (!task)
      throw new Error(`Network lease ${runtime.view.id} disappeared before product delete`);
    return task;
  }

  async cleanup(deadline: ContainerDeadline): Promise<void> {
    const errors: unknown[] = [];
    for (const lease of [...this.leases].reverse()) {
      try {
        await lease.cleanup(deadline);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw aggregateErrorWithDiagnostics(
        `${this.input.label} network cleanup had failures`,
        errors,
      );
    }
  }

  private validateRuntime(
    lease: ContainerLease,
    created: RunningContainerLease,
    server: SeedServer,
  ): ProductNetworkRuntime {
    const ip = created.view.runtime.ip;
    if (typeof ip !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
      throw new Error(`Product container ${created.view.id} has no observable IPv4 address`);
    }
    const result = created.task.result as { ip?: unknown; runtimeId?: unknown } | null;
    if (result?.ip !== ip || result.runtimeId !== created.view.runtime.runtimeId) {
      throw new Error(
        `Product container ${created.view.id} task/runtime network identity mismatch`,
      );
    }
    return { lease, task: created.task, view: created.view, ip, server };
  }
}

export async function withProductNetworkLeasePool(
  input: ProductNetworkPoolInput,
  run: (pool: ProductNetworkLeasePool, deadline: ContainerDeadline) => Promise<void>,
  timeoutMs = 480_000,
): Promise<void> {
  const pool = new ProductNetworkLeasePool(input);
  let primaryFailure: { error: unknown } | null = null;
  try {
    await run(pool, new ContainerDeadline(timeoutMs, `${input.label} network behavior`));
  } catch (error) {
    primaryFailure = { error };
  }

  let cleanupFailure: { error: unknown } | null = null;
  try {
    await pool.cleanup(new ContainerDeadline(360_000, `${input.label} network cleanup`));
  } catch (error) {
    cleanupFailure = { error };
  }
  if (primaryFailure !== null && cleanupFailure !== null) {
    throw aggregateErrorWithDiagnostics(
      `${input.label} behavior and product cleanup both failed`,
      [primaryFailure.error, cleanupFailure.error],
    );
  }
  if (primaryFailure !== null) throw primaryFailure.error;
  if (cleanupFailure !== null) throw cleanupFailure.error;
}

export async function runContainerShell(
  api: APIRequestContext,
  page: Page,
  accessToken: string,
  runtime: ProductNetworkRuntime,
  input: string,
  deadline: ContainerDeadline,
): Promise<{ output: string; exitCode: number }> {
  const session = await expectJson<ConsoleSession>(
    await api.post(`/api/v2/containers/${runtime.view.id}/exec-sessions`, {
      data: { shell: '/bin/sh', tty: false },
      timeout: deadline.remaining(`open console for ${runtime.view.id}`, 30_000),
    }),
    201,
  );
  return executeThroughConsole(
    page,
    requireRuntimeEnv('E2E_BASE_URL'),
    session,
    accessToken,
    input,
    deadline.remaining(`execute console for ${runtime.view.id}`, 30_000),
  );
}

export async function startContainerHttpServer(
  api: APIRequestContext,
  page: Page,
  accessToken: string,
  runtime: ProductNetworkRuntime,
  marker: string,
  deadline: ContainerDeadline,
): Promise<void> {
  assertSafeMarker(marker);
  const contentLength = Buffer.byteLength(marker, 'utf8');
  const result = await runContainerShell(
    api,
    page,
    accessToken,
    runtime,
    `nohup setsid sh -c "while true; do printf 'HTTP/1.1 200 OK\\r\\nContent-Length: ${contentLength}\\r\\nConnection: close\\r\\n\\r\\n${marker}' | nc -l -p 8080; done" >/tmp/nyabase-http.log 2>&1 </dev/null & ready=''; for _ in $(seq 1 30); do body="$(wget -q -T 2 -O - http://127.0.0.1:8080/ 2>/dev/null || true)"; if [ "$body" = '${marker}' ]; then ready=yes; break; fi; sleep 0.1; done; [ "$ready" = yes ] && printf 'HTTP_READY'; exit\n`,
    deadline,
  );
  if (result.exitCode !== 0 || !result.output.includes('HTTP_READY')) {
    throw new Error(`Container ${runtime.view.id} did not start its real HTTP server`);
  }
}

export async function assertContainerPingAndHttp(
  api: APIRequestContext,
  page: Page,
  accessToken: string,
  source: ProductNetworkRuntime,
  targetIp: string,
  expectedBody: string,
  deadline: ContainerDeadline,
): Promise<void> {
  assertIpv4(targetIp);
  assertSafeMarker(expectedBody);
  const result = await runContainerShell(
    api,
    page,
    accessToken,
    source,
    `ping -c 2 -W 2 '${targetIp}' >/dev/null && printf 'HTTP=' && wget -q -T 3 -O - 'http://${targetIp}:8080/'; exit\n`,
    deadline,
  );
  if (result.exitCode !== 0 || !result.output.includes(`HTTP=${expectedBody}`)) {
    throw new Error(
      `Container ${source.view.id} could not reach ${targetIp} through real ICMP and HTTP`,
    );
  }
}

export async function assertContainerPing(
  api: APIRequestContext,
  page: Page,
  accessToken: string,
  source: ProductNetworkRuntime,
  targetIp: string,
  deadline: ContainerDeadline,
): Promise<void> {
  assertIpv4(targetIp);
  const result = await runContainerShell(
    api,
    page,
    accessToken,
    source,
    `ping -c 2 -W 2 '${targetIp}' >/dev/null; exit\n`,
    deadline,
  );
  if (result.exitCode !== 0) {
    throw new Error(`Container ${source.view.id} could not ping ${targetIp}`);
  }
}

export function workloadAddressHost(ip: string): number {
  assertIpv4(ip);
  const host = Number(ip.split('.')[3]);
  if (host < 101 || host > 199) {
    throw new Error(`Product runtime IP ${ip} is outside the reserved .101-.199 workload pool`);
  }
  return host;
}

function assertIpv4(value: string): void {
  const octets = value.split('.').map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    throw new Error(`Invalid IPv4 address ${value}`);
  }
}

function assertSafeMarker(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(value)) {
    throw new Error(`Unsafe network marker ${value}`);
  }
}
