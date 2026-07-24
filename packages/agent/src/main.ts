import { loadAgentConfig, resolveAgentVersion } from './config.js';
import { AgentApplication } from './app.js';
import { DaemonManager } from './docker/daemon-manager.js';
import { acquireProcessGuard } from './process-guard.js';
import { assertHostStorageLayout, HostStorageIdentityGuard } from './host-storage.js';
import {
  readLocalDataSourceIdentity,
  readLocalDataSourceRuntimeIdentity,
} from './datadirs/data-dirs.js';

async function main() {
  if (process.argv.includes('--version')) {
    console.log(resolveAgentVersion());
    return;
  }
  const config = loadAgentConfig();
  const processGuard = await acquireProcessGuard(config.serverId);
  let app: AgentApplication | null = null;
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Agent] ${signal} received, stopping`);
    app?.stop();
    // Keep the kernel-owned process guard live until process death. Releasing
    // it before exit creates a window in which a second Agent can mutate the
    // same host concurrently with this still-running process.
    void processGuard;
    process.exit(0);
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  console.log('[Agent] Starting nyabase-agent v' + config.agentVersion);

  // No unit file, daemon, mount, or quota mutation is allowed until every
  // configured physical root is proved safe and exact.
  assertHostStorageLayout(config);
  const storageIdentity = new HostStorageIdentityGuard(config, {
    readIdentity: readLocalDataSourceIdentity,
    readRuntimeIdentity: readLocalDataSourceRuntimeIdentity,
  });

  // Constructing the manager is side-effect free. AgentApplication performs
  // the local stateless Docker rollback before opening its WebSocket; network
  // and RemoteFS convergence still require Backend bootstrap authority.
  const daemonManager = new DaemonManager(config.dockerRoot, config.isGpuServer, config.dockerResourceLimit);
  app = new AgentApplication(config, daemonManager, storageIdentity);
  await app.start();
  console.log('[Agent] Started, connecting to', config.backendUrl);
}

main().catch((err) => {
  console.error('[Agent] Fatal error:', err);
  process.exit(1);
});
