import { eventually } from './poll.js';

type ContainerSshView = {
  actual?: { status?: string };
  routedIp?: string | null;
  ssh?: { ready?: boolean; status?: string };
};

/**
 * Wait until the control-plane reports ssh.ready.
 *
 * Guest SSH readiness is proven inside the instance via Incus exec by the
 * reconciler. After the vmbr cutover the Incus host can TCP to routedIp:22;
 * callers may add that extra assertion once ssh.ready is true.
 */
export async function waitForContainerSshReady<T extends ContainerSshView>(
  load: () => Promise<T>,
  timeoutMs = 90_000,
  intervalMs = 500,
): Promise<T> {
  return eventually(
    load,
    (value) => (
      value.actual?.status === 'running'
      && typeof value.routedIp === 'string'
      && value.routedIp.length > 0
      && value.ssh?.ready === true
    ),
    timeoutMs,
    intervalMs,
    'container running with SSH ready',
  );
}
