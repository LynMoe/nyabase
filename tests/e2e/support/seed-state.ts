import { readFileSync } from 'node:fs';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

export interface SeedState {
  schemaVersion: 3;
  runId: string;
  profile: 'smoke' | 'core' | 'full';
  adminUserId: string;
  server: {
    id: string;
    createdByRun: boolean;
    name: string;
    endpoint: string;
    certificateFingerprint: string;
    routedParent: string;
    routedSubnet: string;
    routedGateway: string;
    ipPoolId: string;
    systemPoolId: string;
    nodeMetrics: {
      endpoint: string;
      serverCertFingerprint: string;
      tokenFingerprint: string;
    };
  };
  image: {
    id: string;
    alias: string;
    fingerprint: string;
    sourceUrl: string;
    sshdWithoutDhcp: true;
    createdByRun: boolean;
    assignmentId: string;
    assignmentCreatedByRun: boolean;
  };
  preflight: {
    imageAlias: string;
    imageFingerprint: string;
    poolName: string;
    sourceServer: string;
    egressUrl: string;
    status: string;
    report: Record<string, unknown>;
  };
  storagePools: {
    dirQuotaOnline: {
      id: string;
      name: string;
      driver: 'dir';
      quotaOnline: true;
    };
    lvmBlockBacked: {
      id: string;
      name: string;
      driver: 'lvm';
      blockBacked: true;
    };
  };
  sharedBackendId?: string;
  labServers?: Array<{
    id: string;
    createdByRun: boolean;
    name: string;
    endpoint: string;
    certificateFingerprint: string;
    ssh: string;
    parentInterface: string;
    dirPoolId: string;
    cephfsPoolId?: string;
    role?: string;
  }>;
  gpuServer?: {
    id: string;
    name: string;
    slug?: string;
    endpoint: string;
    ssh: string;
    parentInterface: string;
    dirPoolId: string;
    pciAddress: string;
  };
  blocked: {
    gpu: string;
    cephfs: string;
  };
}

export function readSeedState(): SeedState {
  const path = requireRuntimeEnv('E2E_SEED_STATE');
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SeedState>;
  const runId = currentRunId();
  if (parsed.runId !== runId) {
    throw new Error(`Seed state belongs to ${String(parsed.runId)}, expected ${runId}`);
  }
  if (
    parsed.schemaVersion !== 3
    || !parsed.profile
    || !parsed.adminUserId
    || !parsed.server?.id
  ) {
    throw new Error('Seed state is missing the connected Incus server identity');
  }
  if (
    !parsed.server.endpoint?.startsWith('https://')
    || !parsed.server.certificateFingerprint
    || !parsed.server.routedParent
    || !parsed.server.routedSubnet
    || !parsed.server.routedGateway
    || !parsed.server.ipPoolId
    || !parsed.server.systemPoolId
    || !parsed.server.nodeMetrics?.endpoint?.startsWith('https://')
    || !parsed.server.nodeMetrics.serverCertFingerprint
    || !parsed.server.nodeMetrics.tokenFingerprint
  ) {
    throw new Error('Seed state does not prove the HTTPS, routed, and metrics server contract');
  }
  if (
    !parsed.image?.id
    || !parsed.image.alias
    || !/^[a-f0-9]{64}$/i.test(parsed.image.fingerprint)
    || !parsed.image.sourceUrl?.startsWith('https://')
    || parsed.image.sshdWithoutDhcp !== true
    || typeof parsed.image.createdByRun !== 'boolean'
    || !parsed.image.assignmentId
    || typeof parsed.image.assignmentCreatedByRun !== 'boolean'
  ) {
    throw new Error('Seed state is missing the immutable SSHD image ownership and assignment');
  }
  if (
    !parsed.preflight?.imageAlias
    || !/^[a-f0-9]{64}$/i.test(parsed.preflight.imageFingerprint)
    || !parsed.preflight.poolName
    || !parsed.preflight.sourceServer?.startsWith('https://')
    || !parsed.preflight.egressUrl?.startsWith('https://')
    || parsed.preflight.status !== 'passed'
    || parsed.preflight.report?.status !== 'passed'
    || parsed.preflight.report.controlReady !== true
  ) {
    throw new Error('Seed state is missing a control-ready preflight report');
  }
  const dir = parsed.storagePools?.dirQuotaOnline;
  const lvm = parsed.storagePools?.lvmBlockBacked;
  if (
    !dir?.id
    || !dir.name
    || dir.driver !== 'dir'
    || dir.quotaOnline !== true
    || !lvm?.id
    || !lvm.name
    || lvm.driver !== 'lvm'
    || lvm.blockBacked !== true
  ) {
    throw new Error('Seed state must contain both verified storage capability families');
  }
  if (
    !parsed.blocked?.cephfs?.startsWith('BLOCKED:')
    && !parsed.blocked?.cephfs?.startsWith('ENABLED:')
  ) {
    throw new Error('Seed state must mark CephFS as BLOCKED: or ENABLED:');
  }
  const gpuBlocked = parsed.blocked?.gpu?.startsWith('BLOCKED:') === true;
  const gpuProven = parsed.blocked?.gpu?.startsWith('PROVEN:') === true;
  if (!gpuBlocked && !gpuProven) {
    throw new Error('Seed state must mark GPU as BLOCKED: or PROVEN:');
  }
  if (gpuProven) {
    if (
      !parsed.gpuServer?.id
      || !parsed.gpuServer.endpoint?.startsWith('https://')
      || !parsed.gpuServer.ssh
      || !parsed.gpuServer.pciAddress
      || !parsed.gpuServer.dirPoolId
    ) {
      throw new Error('Seed state marks GPU as PROVEN but has no gpuServer identity');
    }
  }
  return parsed as SeedState;
}
