import { eventually } from './poll.js';

type ContainerSshView = {
  actual?: { status?: string };
  routedIp?: string | null;
  ssh?: { ready?: boolean; status?: string };
};

/**
 * Wait until the control-plane reports ssh.ready.
 *
 * Host TCP probes to the container IP are intentionally skipped: macvlan isolates
 * the Incus host from its own containers, so :22 is not reachable from the host.
 * Guest SSH readiness is proven inside the instance via Incus exec by the reconciler.
 */
export async function waitForContainerSshReady<T extends ContainerSshView>(
  load: () => Promise<T>,
  timeoutMs = 180_000,
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
