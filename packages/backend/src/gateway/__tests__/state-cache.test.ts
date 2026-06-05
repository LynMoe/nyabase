import { describe, it, expect, beforeEach } from 'vitest';
import { StateCache } from '../state-cache.js';
import { ContainerStatus, type ContainerSnapshot } from '@nyabase/common';
import type { ServerSnapshot } from '../state-cache.js';

// Helper to build a minimal ServerSnapshot
function makeSnap(serverId: string): ServerSnapshot {
  return {
    serverId,
    agentVersion: '1.0',
    hostname: 'test-host',
    cpuCores: 4,
    totalMemBytes: 8 * 1024 ** 3,
    containers: new Map(),
    disks: [],
    gpus: [],
    xfsProjects: [],
    localImages: [],
    dataDirs: [],
    dataDirIssues: { orphans: [], missing: [] },
    remoteFsMounts: [],
    dockerDaemon: null,
    lastUpdated: Date.now(),
  };
}

function makeContainer(runtimeId: string, ownerId: string, gpuIndices: number[] = []): ContainerSnapshot {
  return {
    spec: {
      runtimeId,
      name: 'test',
      ownerId,
      imageId: 'img-1',
      cpuMillis: 1000,
      memBytes: 512 * 1024 ** 2,
      gpuIndices,
      ip: '10.0.0.1',
      serverId: 'srv-1',
      sshServerEnabled: false,
      dataDirs: [],
      createdAt: new Date().toISOString(),
      specVersion: '2',
    },
    status: ContainerStatus.Running,
    stats: null,
    sshServer: {
      enabled: false,
      status: 'disabled',
      user: 'root',
      port: 22,
    },
  };
}

describe('StateCache', () => {
  let cache: StateCache;

  beforeEach(() => {
    cache = new StateCache();
  });

  describe('hasImage', () => {
    it('matches exact ref:tag', () => {
      const snap = makeSnap('srv-1');
      snap.localImages = [{ id: 'sha256:abc', repoTags: ['ubuntu:22.04'], size: 1000, createdAt: 0 }];
      cache.set('srv-1', snap);

      expect(cache.hasImage('srv-1', 'ubuntu:22.04')).toBe(true);
      expect(cache.hasImage('srv-1', 'ubuntu:20.04')).toBe(false);
    });

    it('ref without tag matches :latest implicitly', () => {
      const snap = makeSnap('srv-1');
      snap.localImages = [{ id: 'sha256:abc', repoTags: ['ubuntu:latest'], size: 1000, createdAt: 0 }];
      cache.set('srv-1', snap);

      expect(cache.hasImage('srv-1', 'ubuntu')).toBe(true);
      expect(cache.hasImage('srv-1', 'ubuntu:latest')).toBe(true);
    });

    it('ref without tag does NOT match other tags', () => {
      const snap = makeSnap('srv-1');
      snap.localImages = [{ id: 'sha256:abc', repoTags: ['ubuntu:22.04'], size: 1000, createdAt: 0 }];
      cache.set('srv-1', snap);

      // 'ubuntu' should not match 'ubuntu:22.04' (would be ambiguous)
      expect(cache.hasImage('srv-1', 'ubuntu')).toBe(false);
    });

    it('returns false for unknown server', () => {
      expect(cache.hasImage('nonexistent', 'ubuntu:22.04')).toBe(false);
    });
  });

  describe('getUserUsageOnServer', () => {
    it('returns zeros when server is unknown', () => {
      const usage = cache.getUserUsageOnServer('user-1', 'srv-x');
      expect(usage).toEqual({ cpuMillis: 0, memBytes: 0, diskBytes: 0 });
    });

    it('aggregates cpu/mem across user containers only', () => {
      const snap = makeSnap('srv-1');
      snap.containers.set('c1', makeContainer('c1', 'user-1', [0]));
      snap.containers.set('c2', makeContainer('c2', 'user-1', [1, 2]));
      snap.containers.set('c3', makeContainer('c3', 'user-2', [3])); // different user
      cache.set('srv-1', snap);

      const usage = cache.getUserUsageOnServer('user-1', 'srv-1');
      expect(usage.cpuMillis).toBe(2000);          // 2 containers × 1000
      expect(usage.memBytes).toBe(2 * 512 * 1024 ** 2);
      expect('gpuCount' in usage).toBe(false);     // gpuCount removed
    });
  });

  describe('pickGpuIndices', () => {
    it('returns least-loaded GPUs first', () => {
      const snap = makeSnap('srv-1');
      snap.gpus = [
        { index: 0, uuid: 'GPU-0', model: 'A100', totalMemMiB: 80000 },
        { index: 1, uuid: 'GPU-1', model: 'A100', totalMemMiB: 80000 },
        { index: 2, uuid: 'GPU-2', model: 'A100', totalMemMiB: 80000 },
      ];
      // GPU 0 has 2 containers, GPU 1 has 1, GPU 2 has 0
      snap.containers.set('c1', makeContainer('c1', 'u1', [0]));
      snap.containers.set('c2', makeContainer('c2', 'u1', [0]));
      snap.containers.set('c3', makeContainer('c3', 'u1', [1]));
      cache.set('srv-1', snap);

      const picked = cache.pickGpuIndices('srv-1', 2);
      expect(picked[0]).toBe(2); // least loaded
      expect(picked[1]).toBe(1);
    });

    it('bounds GPU load maps and picks to actual inventory', () => {
      const snap = makeSnap('srv-1');
      snap.gpus = [
        { index: 0, uuid: 'GPU-0', model: 'A100', totalMemMiB: 80000 },
        { index: 1, uuid: 'GPU-1', model: 'A100', totalMemMiB: 80000 },
        { index: 2, uuid: 'GPU-2', model: 'A100', totalMemMiB: 80000 },
        { index: 3, uuid: 'GPU-3', model: 'A100', totalMemMiB: 80000 },
      ];
      snap.containers.set('c1', makeContainer('c1', 'u1', [4, 5]));
      snap.containers.set('c2', makeContainer('c2', 'u1', [0]));
      cache.set('srv-1', snap);

      expect(cache.getGpuLoadMap('srv-1')).toEqual(new Map([
        [0, 1],
        [1, 0],
        [2, 0],
        [3, 0],
      ]));
      expect(cache.pickGpuIndices('srv-1', 6)).toEqual([1, 2, 3, 0]);
      expect(cache.isGpuFree('srv-1', 4)).toBe(false);
    });
  });

  describe('applyContainerEvent', () => {
    it('updates container status on start/stop/die', () => {
      const snap = makeSnap('srv-1');
      const c = makeContainer('c1', 'u1');
      c.status = ContainerStatus.Exited;
      snap.containers.set('c1', c);
      cache.set('srv-1', snap);

      cache.applyContainerEvent('srv-1', 'c1', 'start');
      expect(cache.getContainer('srv-1', 'c1')?.status).toBe(ContainerStatus.Running);

      cache.applyContainerEvent('srv-1', 'c1', 'die');
      expect(cache.getContainer('srv-1', 'c1')?.status).toBe(ContainerStatus.Exited);
    });

    it('removes container on destroy', () => {
      const snap = makeSnap('srv-1');
      snap.containers.set('c1', makeContainer('c1', 'u1'));
      cache.set('srv-1', snap);

      cache.applyContainerEvent('srv-1', 'c1', 'destroy');
      expect(cache.getContainer('srv-1', 'c1')).toBeUndefined();
    });
  });
});
