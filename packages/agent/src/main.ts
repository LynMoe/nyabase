import { execFileSync } from 'child_process';
import { loadAgentConfig } from './config.js';
import { AgentApplication } from './app.js';
import { DaemonManager } from './docker/daemon-manager.js';
import { resolveAndExtractMountHelper } from './mountHelperEmbed.js';

async function main() {
  const config = loadAgentConfig();
  console.log('[Agent] Starting nyabase-agent v' + config.agentVersion);

  config.mountHelperPath = resolveAndExtractMountHelper(config.mountHelperPath);

  let mountHelperOk = false;
  try {
    execFileSync(config.mountHelperPath, ['--version'], { timeout: 3000 });
    mountHelperOk = true;
    console.log('[Agent] mount-helper OK:', config.mountHelperPath);
  } catch {
    console.warn('[Agent] WARNING: mount-helper not found or failed at', config.mountHelperPath);
    console.warn('[Agent] Dynamic container mounts will not work.');
  }

  // Ensure the nyabase-managed dockerd is running with the correct unit file.
  const daemonManager = new DaemonManager(config.dockerRoot, config.isGpuServer, config.dockerResourceLimit);
  console.log('[Agent] Reconciling nyabase-docker daemon (dockerRoot:', config.dockerRoot, ')...');
  try {
    await daemonManager.reconcile(config.serverId);
    console.log('[Agent] nyabase-docker daemon is running');
  } catch (err) {
    console.error('[Agent] Fatal: failed to start nyabase-docker daemon:', err);
    process.exit(1);
  }

  const app = new AgentApplication(config, mountHelperOk, daemonManager);
  app.start();
  console.log('[Agent] Started, connecting to', config.backendUrl);
}

main().catch((err) => {
  console.error('[Agent] Fatal error:', err);
  process.exit(1);
});
