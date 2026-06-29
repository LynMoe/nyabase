import * as os from 'os';

export const DOCKER_LIMIT_SLICE_NAME = 'nyabase-docker-limit.slice';
export const DOCKER_LIMIT_SLICE_PATH = `/etc/systemd/system/${DOCKER_LIMIT_SLICE_NAME}`;
export const MAX_HOST_RESERVED_MEMORY_BYTES = 64 * 1024 ** 3;

export interface DockerResourceLimitConfig {
  enabled: boolean;
}

export interface DockerResourceLimitPlan {
  enabled: boolean;
  cgroupParent: string | null;
  cpu: {
    hostCores: number;
    reservedCores: number;
    dockerCores: number | null;
    quotaPercent: number | null;
  };
  memory: {
    totalBytes: number;
    reservedBytes: number;
    maxBytes: number | null;
    highBytes: number | null;
  };
}

export function getHostResourceSnapshot(): { cpuCores: number; totalMemBytes: number } {
  return {
    cpuCores: os.cpus().length,
    totalMemBytes: os.totalmem(),
  };
}

export function calculateDockerResourceLimitPlan(
  config: DockerResourceLimitConfig,
  host: { cpuCores: number; totalMemBytes: number },
): DockerResourceLimitPlan {
  if (!config.enabled) {
    return {
      enabled: false,
      cgroupParent: null,
      cpu: {
        hostCores: host.cpuCores,
        reservedCores: 0,
        dockerCores: null,
        quotaPercent: null,
      },
      memory: {
        totalBytes: host.totalMemBytes,
        reservedBytes: 0,
        maxBytes: null,
        highBytes: null,
      },
    };
  }

  const reservedCores = host.cpuCores < 12 ? 0 : Math.floor(host.cpuCores / 12);
  const dockerCores = reservedCores > 0 ? Math.max(host.cpuCores - reservedCores, 1) : null;
  const memoryReservedBytes = Math.floor(Math.min(host.totalMemBytes * 0.1, MAX_HOST_RESERVED_MEMORY_BYTES));
  const memoryMaxBytes = Math.max(host.totalMemBytes - memoryReservedBytes, 0);

  return {
    enabled: true,
    cgroupParent: DOCKER_LIMIT_SLICE_NAME,
    cpu: {
      hostCores: host.cpuCores,
      reservedCores,
      dockerCores,
      quotaPercent: dockerCores === null ? null : dockerCores * 100,
    },
    memory: {
      totalBytes: host.totalMemBytes,
      reservedBytes: memoryReservedBytes,
      maxBytes: memoryMaxBytes,
      highBytes: Math.floor(memoryMaxBytes * 0.9),
    },
  };
}

