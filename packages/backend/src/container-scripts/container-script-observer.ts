import { deriveInstanceName, type IncusClientPort } from '../incus/index.js';
import { bootIdOf } from './container-script-runner.js';
import type { InstanceObservation } from './container-script-targets.repository.js';

/**
 * Status and boot of every container on one server from one cheap instance
 * list (`recursion=1`: no state, but `status` and `last_used_at`). A container
 * Incus does not list is `missing`.
 */
export async function observeServer(
  client: IncusClientPort,
  containers: ReadonlyArray<{ readonly id: string; readonly instance_name: string | null }>,
  signal: AbortSignal,
): Promise<InstanceObservation[]> {
  const listed = (await client.listInstances(1, { signal })).metadata ?? [];
  const byName = new Map<string, { status?: string; last_used_at?: string }>();
  for (const instance of listed as Array<{ name?: string; status?: string; last_used_at?: string }>) {
    if (typeof instance.name === 'string') byName.set(instance.name, instance);
  }
  return containers.map((container) => {
    const instance = byName.get(container.instance_name ?? deriveInstanceName(container.id));
    return instance
      ? {
        containerId: container.id,
        status: (instance.status ?? 'unknown').toLowerCase(),
        bootId: bootIdOf(instance.last_used_at),
      }
      : { containerId: container.id, status: 'missing', bootId: null };
  });
}
