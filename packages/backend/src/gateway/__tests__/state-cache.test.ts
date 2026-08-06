import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StateCache } from '../state-cache.js';
import type { ServerSnapshot } from '../state-cache.js';

// Helper to build a minimal ServerSnapshot
function makeSnap(serverId: string): ServerSnapshot {
  return {
    serverId,
    runtimeReady: true,
    sessionId: 'session-a',
    helloAt: Date.now(),
    lastFullReportAt: Date.now(),
    lastFullReportReceivedAt: Date.now(),
    agentVersion: '1.0',
    hostname: 'test-host',
    cpuCores: 4,
    totalMemBytes: 8 * 1024 ** 3,
    dockerRoot: '/var/lib/nyabase-docker',
    containers: new Map(),
    disks: [],
    gpus: [],
    xfsProjects: [],
    unknownXfsNumericIds: [],
    localImages: [],
    dataDirs: [],
    dataDirIssues: { orphans: [], missing: [] },
    remoteFsMounts: [],
    dockerDaemon: null,
    lastUpdated: Date.now(),
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

    it('requires the explicit latest tag', () => {
      const snap = makeSnap('srv-1');
      snap.localImages = [{ id: 'sha256:abc', repoTags: ['ubuntu:latest'], size: 1000, createdAt: 0 }];
      cache.set('srv-1', snap);

      expect(cache.hasImage('srv-1', 'ubuntu')).toBe(false);
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

  it('hydrates the independently reported Docker daemon projection for API readers', async () => {
    const report = {
      ...makeSnap('srv-1'),
      containers: [],
      dockerDaemon: null,
    };
    const dockerDaemon = {
      serverId: 'srv-1',
      state: 'active',
      unitFileInSync: true,
      enabled: true,
      active: true,
      pid: 42,
      dockerRoot: '/var/lib/nyabase-docker',
      socketPath: '/run/nyabase-docker.sock',
      serverVersion: '26.1.0',
      storageDriver: 'overlay2',
      lastError: null,
      checkedAt: Date.now(),
    };
    const rows = [{
      server_id: 'srv-1',
      session_id: 'session-a',
      runtime_ready: true,
      state_report_json: report,
      docker_daemon_json: dockerDaemon,
    }];
    const query = {
      innerJoin: () => query,
      select: () => query,
      where: () => query,
      whereRef: () => query,
      execute: async () => rows,
    };
    const projectionCache = new StateCache(
      { selectFrom: () => query } as never,
      { servesApi: () => true, servesGateway: () => false, runsWorker: () => false } as never,
    );

    await projectionCache.onModuleInit();
    try {
      expect(projectionCache.get('srv-1')?.dockerDaemon).toEqual(dockerDaemon);
    } finally {
      projectionCache.onModuleDestroy();
    }
  });

  it('polls durable projections on the worker role so expiry actions see runtime readiness', async () => {
    const report = {
      serverId: 'srv-worker',
      sessionId: 'session-worker',
      hostname: 'worker-host',
      lastUpdated: Date.now(),
      runtimeReady: true,
      containers: [],
      disks: [],
      gpus: [],
      localImages: [],
      dataDirs: [],
      remoteFsMounts: [],
      xfsProjects: [],
      unknownXfsNumericIds: [],
      dataDirIssues: { orphans: [], missing: [] },
      dockerDaemon: null,
    };
    const rows = [{
      server_id: 'srv-worker',
      session_id: 'session-worker',
      runtime_ready: true,
      state_report_json: report,
      docker_daemon_json: null,
    }];
    const query = {
      innerJoin: () => query,
      select: () => query,
      where: () => query,
      whereRef: () => query,
      execute: async () => rows,
    };
    const projectionCache = new StateCache(
      { selectFrom: () => query } as never,
      { servesApi: () => false, servesGateway: () => false, runsWorker: () => true } as never,
    );

    await projectionCache.onModuleInit();
    try {
      expect(projectionCache.isRuntimeReady('srv-worker')).toBe(true);
    } finally {
      projectionCache.onModuleDestroy();
    }
  });

  it('single-flights slow API projection polls and drains them on shutdown', async () => {
    let resolve!: (rows: never[]) => void;
    const execute = vi.fn(() => new Promise<never[]>((done) => { resolve = done; }));
    const query = {
      innerJoin: () => query,
      select: () => query,
      where: () => query,
      whereRef: () => query,
      execute,
    };
    const projectionCache = new StateCache(
      { selectFrom: () => query } as never,
      { servesApi: () => true, servesGateway: () => false, runsWorker: () => false } as never,
    );

    const first = projectionCache.onModuleInit();
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    const second = (projectionCache as unknown as {
      pollDurableProjections: () => Promise<void>;
    }).pollDurableProjections();
    expect(execute).toHaveBeenCalledOnce();
    const destroy = projectionCache.onModuleDestroy();
    resolve([]);
    await Promise.all([first, second, destroy]);
    expect(execute).toHaveBeenCalledOnce();
    expect(projectionCache.isProjectionReady()).toBe(false);
  });

  it('contains rejected projection polls, preserves the last snapshot, and fails readiness closed', async () => {
    const query = {
      innerJoin: () => query,
      select: () => query,
      where: () => query,
      whereRef: () => query,
      execute: vi.fn().mockRejectedValue(new Error('postgres unavailable')),
    };
    const projectionCache = new StateCache(
      { selectFrom: () => query } as never,
      { servesApi: () => true, servesGateway: () => false, runsWorker: () => false } as never,
    );
    const existing = makeSnap('server-a');
    projectionCache.set(existing.serverId, existing);

    await expect(projectionCache.onModuleInit()).resolves.toBeUndefined();
    expect(projectionCache.get(existing.serverId)).toBe(existing);
    expect(projectionCache.isProjectionReady()).toBe(false);
    await projectionCache.onModuleDestroy();
  });

});
