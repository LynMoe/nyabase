import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type { DiskInfo } from '@nyabase/common';
import type { AgentConfig } from './config.js';

const MACHINE_ID_PATHS = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
const PLATFORM_ID_PATHS = ['/sys/class/dmi/id/product_uuid', '/sys/devices/virtual/dmi/id/product_uuid'];

/** Derive a stable, non-secret host identity without Agent-owned state. */
export function getHostFingerprint(): string {
  const machineId = readMachineId();
  const platformId = readFirst(PLATFORM_ID_PATHS);
  return createHash('sha256')
    .update('nyabase-agent-host-v2\0')
    .update(machineId)
    .update('\0')
    .update(platformId ?? 'platform-id-unavailable')
    .digest('hex');
}

/**
 * Bind every static setting that changes physical resource addressing. The
 * token, Backend URL, metrics cadence and Agent version are intentionally not
 * included because they do not select host resources.
 */
export function getAgentConfigFingerprint(
  config: AgentConfig,
  disks: readonly DiskInfo[],
  dockerRootIdentity: string,
): string {
  if (!dockerRootIdentity) throw new Error('dockerRoot has no verified physical identity');
  const identities = new Map(disks.map((disk) => [disk.diskId, disk.sourceIdentity]));
  const localDataSources = config.localDataSources
    .map((source) => {
      const sourceIdentity = identities.get(source.id);
      if (!sourceIdentity) throw new Error(`Local data source ${source.id} has no verified physical identity`);
      return {
        id: source.id,
        mountPoint: path.resolve(source.mountPoint),
        sourceIdentity,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
  const semanticConfig = {
    serverId: config.serverId,
    dockerRoot: path.resolve(config.dockerRoot),
    dockerRootIdentity,
    parentIface: config.parentIface,
    macvlanCidr: config.macvlanCidr,
    macvlanGateway: config.macvlanGateway,
    reservedIps: [...config.reservedIps].sort(),
    isGpuServer: config.isGpuServer,
    dockerResourceLimit: { enabled: config.dockerResourceLimit.enabled },
    localDataSources,
  };
  return createHash('sha256')
    .update('nyabase-agent-config-v1\0')
    .update(JSON.stringify(semanticConfig))
    .digest('hex');
}

function readMachineId(): string {
  const value = readFirst(MACHINE_ID_PATHS);
  if (value) return value;
  throw new Error('Cannot derive host fingerprint: Linux machine-id is unavailable');
}

function readFirst(paths: readonly string[]): string | null {
  for (const candidate of paths) {
    try {
      const value = fs.readFileSync(candidate, 'utf8').trim().toLowerCase();
      if (value) return value;
    } catch {
      // Try the next platform identity path.
    }
  }
  return null;
}
