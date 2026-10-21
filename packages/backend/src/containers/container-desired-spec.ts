import {
  buildDesiredInstanceSpec,
  mergeInstanceSpecContributions,
  type DesiredInstanceSpec,
  type InstanceSpecAttachmentInput,
} from '../incus/instance-spec.js';
import { gpuInstanceSpec } from '../gpu/instance-spec.js';
import type { ContainerAttachment, ContainerRow } from './container-reconcile-support.js';

export function toSpecAttachments(
  attachments: readonly ContainerAttachment[],
): InstanceSpecAttachmentInput[] {
  return attachments.map<InstanceSpecAttachmentInput>((attachment) => ({
    id: attachment.id,
    containerPath: attachment.container_path,
    readOnly: attachment.read_only,
    volume: {
      id: attachment.volume_id,
      incusName: attachment.incus_name,
      poolName: attachment.pool_name,
    },
  }));
}

/** The Incus instance document the platform wants for this container. */
export function buildContainerSpec(
  row: ContainerRow,
  attachments: readonly InstanceSpecAttachmentInput[],
): DesiredInstanceSpec {
  const base = buildDesiredInstanceSpec({
    container: {
      id: row.id,
      serverId: row.server_id,
      revision: row.revision,
      imageFingerprint: row.image_fingerprint,
      cpuMillis: row.cpu_millis,
      memBytes: row.mem_bytes,
      nesting: row.nesting,
      syscallIntercept: row.syscall_intercept,
      rootPool: row.root_pool_name,
      rootSizeBytes: row.root_size_bytes,
      routedIp: row.routed_ip ?? '',
    },
    server: {
      id: row.server_id,
      parentInterface: row.parent_interface ?? '',
    },
    attachments,
  });
  // GPU contributes only while the server has it enabled.
  const contributions = row.gpu_enabled ? [gpuInstanceSpec(row.gpu_state)] : [];
  return mergeInstanceSpecContributions(base, contributions);
}
