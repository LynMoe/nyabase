import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createAgentHandlers } from './agent.js';
import { BackendConnection } from './backend-connection.js';
import { LinuxNodeMetricsCollector } from './collector.js';
import { controlUrl, loadAgentConfig, type AgentConfig } from './config.js';
import { collectContainerCgroupMetrics } from './container-cgroup.js';
import { CredentialStore } from './credential-store.js';
import { EnrollmentRejectedError, enroll } from './enroll.js';
import { collectNvidiaGpuMetrics } from './gpu-collector.js';
import { LocalIncus } from './incus-local.js';
import { Ipv6Guard } from './ipv6-guard.js';

const GUARD_INTERVAL_MS = 30_000;
const ENROLL_RETRY_MS = 10_000;

function log(message: string): void {
  console.log(`[nyabase-agent] ${message}`);
}

function agentVersion(): string {
  try {
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Exchange the enrollment token, retrying transport failures; a rejection is final. */
async function enrollUntilAccepted(config: AgentConfig, store: CredentialStore, signal: AbortSignal): Promise<string> {
  if (!config.enrollmentToken) {
    throw new Error('No stored credential and NYABASE_AGENT_ENROLLMENT_TOKEN is not set');
  }
  while (!signal.aborted) {
    try {
      const result = await enroll(config, config.enrollmentToken);
      await store.write(result.credential);
      log(`enrolled as server ${result.serverId}`);
      return result.credential;
    } catch (error) {
      if (error instanceof EnrollmentRejectedError) throw error;
      log(`enrollment failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
      await new Promise((resolve) => setTimeout(resolve, ENROLL_RETRY_MS));
    }
  }
  throw new Error('stopped before enrollment completed');
}

async function main(): Promise<void> {
  const config = await loadAgentConfig();
  const controller = new AbortController();
  const shutdown = (): void => controller.abort();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  const store = new CredentialStore(config.stateDir);
  let credential = await store.read() ?? await enrollUntilAccepted(config, store, controller.signal);

  const guard = new Ipv6Guard();
  const ensureGuard = async (): Promise<void> => {
    if (!await guard.ensure()) log(`IPv6 guard is not in place: ${guard.error ?? 'unknown error'}`);
  };
  await ensureGuard();
  const guardTimer = setInterval(() => void ensureGuard(), GUARD_INTERVAL_MS);

  const incus = new LocalIncus(config.incusSocket);
  const metrics = new LinuxNodeMetricsCollector({
    extraCollectors: [collectNvidiaGpuMetrics, collectContainerCgroupMetrics],
  });
  const connection = new BackendConnection({
    url: controlUrl(config),
    ca: config.backendCa,
    credential: () => credential,
    log,
    handlers: createAgentHandlers({
      config,
      incus,
      guard,
      metrics,
      credential: () => credential,
      version: agentVersion(),
      log,
    }),
    // A rotated enrollment re-issues the credential; re-enroll when a fresh token was provided.
    onCredentialRejected: async () => {
      if (!config.enrollmentToken) return;
      try {
        const result = await enroll(config, config.enrollmentToken);
        await store.write(result.credential);
        credential = result.credential;
        log(`re-enrolled as server ${result.serverId}`);
      } catch (error) {
        log(`re-enrollment failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  log(`connecting to ${controlUrl(config)}`);
  await connection.run(controller.signal);
  clearInterval(guardTimer);
}

main().catch((error: unknown) => {
  console.error('[nyabase-agent] fatal:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
