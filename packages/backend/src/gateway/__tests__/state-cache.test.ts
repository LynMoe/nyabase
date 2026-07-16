import { describe, it, expect, beforeEach } from 'vitest';
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

});
