import { readFileSync } from 'node:fs';
import { currentRunId, requireRuntimeEnv } from './runtime-env.js';

export interface SeedServer {
  key: 'node1' | 'node2';
  serverId: string;
  outerIp: string;
}

export interface SeedState {
  runId: string;
  adminUserId: string;
  image: {
    id: string;
    dockerImage: string;
    registryDigest: string;
  };
  uiImage: {
    dockerImage: string;
    registryDigest: string;
    sourceImageId: string;
  };
  proxyImage?: {
    id: string;
    dockerImage: string;
    registryDigest: string;
    sourceImageId: string;
    disableSsh: false;
  };
  servers: SeedServer[];
  mountSourceGrants: Array<{
    grantId: string;
    serverId: string;
    diskId: string;
    sourceIdentity: string;
  }>;
  taskIds: {
    quota: string[];
    imagePull: string[];
    proxyImagePull?: string[];
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
    !parsed.adminUserId
    || !parsed.image?.id
    || !parsed.image.dockerImage
    || !parsed.image.registryDigest
  ) {
    throw new Error('Seed state is missing admin or immutable workload identity');
  }
  if (
    !parsed.uiImage?.dockerImage
    || !parsed.uiImage.registryDigest
    || !parsed.uiImage.sourceImageId
  ) {
    throw new Error('Seed state is missing the real UI image fixture identity');
  }
  if (!Array.isArray(parsed.servers) || parsed.servers.length !== 2) {
    throw new Error('Seed state must contain exactly two real CPU servers');
  }
  const serverIds = new Set(parsed.servers.map((server) => server.serverId));
  const serverKeys = new Set(parsed.servers.map((server) => server.key));
  if (serverIds.size !== 2 || serverKeys.size !== 2 || !serverKeys.has('node1') || !serverKeys.has('node2')) {
    throw new Error('Seed server identities are missing or duplicated');
  }
  if (
    !Array.isArray(parsed.mountSourceGrants)
    || parsed.mountSourceGrants.length !== 2
    || new Set(parsed.mountSourceGrants.map((grant) => grant.serverId)).size !== 2
    || parsed.mountSourceGrants.some((grant) => (
      !serverIds.has(grant.serverId)
      || !grant.grantId
      || !grant.diskId
      || !grant.sourceIdentity
    ))
  ) {
    throw new Error('Seed state must contain one real local mount-source grant per CPU server');
  }
  if (
    !parsed.taskIds
    || !Array.isArray(parsed.taskIds.quota)
    || parsed.taskIds.quota.length !== 2
    || !Array.isArray(parsed.taskIds.imagePull)
    || parsed.taskIds.imagePull.length !== 2
  ) {
    throw new Error('Seed state must contain two quota and two image-pull durable tasks');
  }
  if (process.env.E2E_PROFILE === 'full') {
    if (
      !parsed.proxyImage?.id
      || !parsed.proxyImage.dockerImage
      || !parsed.proxyImage.registryDigest
      || !parsed.proxyImage.sourceImageId
      || parsed.proxyImage.disableSsh !== false
      || !Array.isArray(parsed.taskIds.proxyImagePull)
      || parsed.taskIds.proxyImagePull.length !== 2
    ) {
      throw new Error('Full seed state is missing the real SSH/HTTP proxy target image');
    }
  }

  return parsed as SeedState;
}
