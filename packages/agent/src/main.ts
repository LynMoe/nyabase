import { AGENT_PROTOCOL_VERSION, parseAgentSecret } from '@nyabase/common';
import { createAgentHandlers, hostStatus } from './agent.js';
import { BackendConnection } from './backend-connection.js';
import { readAgentBuild } from './build-info.js';
import { LinuxNodeMetricsCollector } from './collector.js';
import { agentStateDir, controlUrl, loadAgentConfig, type AgentConfig } from './config.js';
import { collectContainerCgroupMetrics } from './container-cgroup.js';
import { CredentialStore } from './credential-store.js';
import { enroll, enrollUntilAccepted } from './enroll.js';
import type { GuestFirewall } from './firewall.js';
import { collectNvidiaGpuMetrics } from './gpu-collector.js';
import { startGuestGuards, storedServerId } from './guest-guards.js';
import { LocalIncus } from './incus-local.js';
import type { Ipv6Guard } from './ipv6-guard.js';
import { NftMonitorHub, SystemNftRunner } from './nft.js';
import { OperationLedger } from './operation-ledger.js';

/** Backstop for `nft monitor` (which may be unavailable or restarting). */
const GUARD_INTERVAL_MS = 10_000;

function log(message: string): void {
  console.log(`[nyabase-agent] ${message}`);
}

/**
 * `node dist/main.js guest-guards` (alias `ipv6-guard`): put the IPv6 guard
 * and the egress firewall (the persisted document, or the fail-closed table)
 * in place once and exit, non-zero when either table is not in place. The
 * systemd unit runs it before Incus starts, so containers Incus restores at
 * boot never come up without them. Reads only NYABASE_AGENT_STATE_DIR.
 */
async function applyGuestGuardsOnce(): Promise<void> {
  const stateDir = agentStateDir();
  const { guard, firewall, guardInPlace, firewallRestored } = await startGuestGuards({
    stateDir,
    serverId: await storedServerId(stateDir),
    log,
  });
  log(guardInPlace ? 'IPv6 guard is in place' : `IPv6 guard is not in place: ${guard.error ?? 'unknown error'}`);
  if (firewallRestored === 'document') log(`egress firewall ${firewall.status().digest?.slice(0, 12)} is in place`);
  else if (firewallRestored === 'fail-closed') log(`egress firewall is closed (fail-closed table): ${firewall.refusal ?? 'no document'}`);
  else log(`egress firewall is not in place: ${firewall.refusal ?? 'unknown error'}`);
  if (!guardInPlace || firewallRestored === 'none') process.exitCode = 1;
}

function logStatusChanges(guard: Ipv6Guard, firewall: GuestFirewall): void {
  guard.onChange((status) => {
    log(status.present
      ? 'IPv6 guard is in place'
      : `IPv6 guard is not in place, guest NICs will not be brought up: ${status.error ?? 'unknown error'}`);
  });
  firewall.onChange((status) => {
    log(status.present
      ? `egress firewall ${status.digest?.slice(0, 12)} is in place`
      : `egress firewall is not in place, guest NICs will not be brought up: ${firewall.refusal ?? 'unknown error'}`);
  });
}

async function main(): Promise<void> {
  const config = await loadAgentConfig();
  const build = readAgentBuild();
  log(`nyabase-agent ${build.version} (protocol ${AGENT_PROTOCOL_VERSION}${build.commit ? `, commit ${build.commit}` : ''})`);
  const controller = new AbortController();
  const shutdown = (): void => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  // Both tables protect guests whether or not the Backend is reachable: first.
  const nft = new SystemNftRunner();
  const { guard, firewall } = await startGuestGuards({
    stateDir: config.stateDir,
    serverId: await storedServerId(config.stateDir),
    nft,
    log,
  });
  logStatusChanges(guard, firewall);
  log(`IPv6 guard is ${guard.status().present ? 'in place' : `not in place: ${guard.error ?? 'unknown error'}`}`);
  log(`egress firewall: ${firewall.refusal ?? 'in place'}`);
  // One `nft monitor` for both, each with its own debounce and back-off.
  const monitor = new NftMonitorHub(nft);
  const stopGuard = guard.watch(monitor);
  const stopFirewall = firewall.watch(monitor);
  const timer = setInterval(() => {
    void guard.ensure();
    void firewall.ensure();
  }, GUARD_INTERVAL_MS);
  try {
    await serve(config, build.version, guard, firewall, controller.signal);
  } finally {
    clearInterval(timer);
    stopGuard();
    stopFirewall();
  }
}

function serverIdOf(credential: string): string | undefined {
  return parseAgentSecret('credential', credential)?.serverId;
}

/** Enroll if needed, then hold the control connection until `signal` aborts. */
async function serve(
  config: AgentConfig,
  version: string,
  guard: Ipv6Guard,
  firewall: GuestFirewall,
  signal: AbortSignal,
): Promise<void> {
  const store = new CredentialStore(config.stateDir);
  const exchange = (token: string): ReturnType<typeof enroll> => enroll(config, token);
  const enrollFromEnvironment = (): Promise<string> => {
    if (!config.enrollmentToken) {
      throw new Error('No stored credential and NYABASE_AGENT_ENROLLMENT_TOKEN is not set');
    }
    return enrollUntilAccepted(config.enrollmentToken, signal, { exchange, store, log });
  };
  let credential = await store.read() ?? await enrollFromEnvironment();
  const adopt = async (value: string): Promise<void> => {
    const serverId = serverIdOf(value);
    if (serverId) await firewall.setServerId(serverId);
  };
  await adopt(credential);

  const incus = new LocalIncus(config.incusSocket);
  const metrics = new LinuxNodeMetricsCollector({
    extraCollectors: [collectNvidiaGpuMetrics, collectContainerCgroupMetrics],
  });
  const connection = new BackendConnection({
    url: controlUrl(config),
    ca: config.backendCa,
    credential: () => credential,
    log,
    status: () => hostStatus({ guard, firewall }),
    onDisconnected: () => firewall.resetConfirmation(),
    handlers: createAgentHandlers({
      config,
      incus,
      guard,
      firewall,
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
        await adopt(credential);
        log(`re-enrolled as server ${result.serverId}`);
      } catch (error) {
        log(`re-enrollment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  guard.onChange(() => connection.publishStatus());
  firewall.onChange(() => connection.publishStatus());
  log(`connecting to ${controlUrl(config)}`);
  await connection.run(signal);
}

const command = process.argv[2];
(command === 'guest-guards' || command === 'ipv6-guard' ? applyGuestGuardsOnce() : main()).catch((error: unknown) => {
  console.error('[nyabase-agent] fatal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
