import { AGENT_PROTOCOL_VERSION } from '@nyabase/common';
import { createAgentHandlers } from './agent.js';
import { BackendConnection } from './backend-connection.js';
import { readAgentBuild } from './build-info.js';
import { LinuxNodeMetricsCollector } from './collector.js';
import { controlUrl, loadAgentConfig, type AgentConfig } from './config.js';
import { collectContainerCgroupMetrics } from './container-cgroup.js';
import { CredentialStore } from './credential-store.js';
import { enroll, enrollUntilAccepted } from './enroll.js';
import { collectNvidiaGpuMetrics } from './gpu-collector.js';
import { LocalIncus } from './incus-local.js';
import { OperationLedger } from './operation-ledger.js';
import { Ipv6Guard } from './ipv6-guard.js';

/** Backstop for `nft monitor` (which may be unavailable or restarting). */
const GUARD_INTERVAL_MS = 10_000;

function log(message: string): void {
  console.log(`[nyabase-agent] ${message}`);
}

/**
 * `node dist/main.js ipv6-guard`: put the guard table in place once and exit
 * (non-zero when it does not verify). The systemd unit runs it before Incus
 * starts, so containers Incus restores at boot never come up without it.
 */
async function applyGuardOnce(): Promise<void> {
  const guard = new Ipv6Guard();
  if (await guard.ensure()) {
    log('IPv6 guard is in place');
    return;
  }
  log(`IPv6 guard is not in place: ${guard.error ?? 'unknown error'}`);
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const config = await loadAgentConfig();
  const build = readAgentBuild();
  log(`nyabase-agent ${build.version} (protocol ${AGENT_PROTOCOL_VERSION}${build.commit ? `, commit ${build.commit}` : ''})`);
  const controller = new AbortController();
  const shutdown = (): void => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // The guard protects guests whether or not the Backend is reachable: first.
  const guard = new Ipv6Guard();
  guard.onChange(({ ipv6Guard }) => {
    log(ipv6Guard.present
      ? 'IPv6 guard is in place'
      : `IPv6 guard is not in place, guest NICs will not be brought up: ${ipv6Guard.error ?? 'unknown error'}`);
  });
  await guard.ensure();
  const stopWatching = guard.watch();
  const guardTimer = setInterval(() => void guard.ensure(), GUARD_INTERVAL_MS);
  try {
    await serve(config, build.version, guard, controller.signal);
  } finally {
    clearInterval(guardTimer);
    stopWatching();
  }
}

/** Enroll if needed, then hold the control connection until `signal` aborts. */
async function serve(config: AgentConfig, version: string, guard: Ipv6Guard, signal: AbortSignal): Promise<void> {
  const store = new CredentialStore(config.stateDir);
  const exchange = (token: string): ReturnType<typeof enroll> => enroll(config, token);
  const enrollFromEnvironment = (): Promise<string> => {
    if (!config.enrollmentToken) {
      throw new Error('No stored credential and NYABASE_AGENT_ENROLLMENT_TOKEN is not set');
    }
    return enrollUntilAccepted(config.enrollmentToken, signal, { exchange, store, log });
  };
  let credential = await store.read() ?? await enrollFromEnvironment();

  const incus = new LocalIncus(config.incusSocket);
  const metrics = new LinuxNodeMetricsCollector({
    extraCollectors: [collectNvidiaGpuMetrics, collectContainerCgroupMetrics],
  });
  const connection = new BackendConnection({
    url: controlUrl(config),
    ca: config.backendCa,
    credential: () => credential,
    log,
    status: () => guard.status(),
    handlers: createAgentHandlers({
      config,
      incus,
      guard,
      operations: new OperationLedger(),
      metrics,
      credential: () => credential,
      version,
      log,
    }),
    // A rotated enrollment re-issues the credential; re-enroll when a fresh token was provided.
    onCredentialRejected: async () => {
      if (!config.enrollmentToken) return;
      try {
        const result = await exchange(config.enrollmentToken);
        await store.write(result.credential);
        credential = result.credential;
        log(`re-enrolled as server ${result.serverId}`);
      } catch (error) {
        log(`re-enrollment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  guard.onChange(() => connection.publishStatus());
  log(`connecting to ${controlUrl(config)}`);
  await connection.run(signal);
}

(process.argv[2] === 'ipv6-guard' ? applyGuardOnce() : main()).catch((error: unknown) => {
  console.error('[nyabase-agent] fatal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
