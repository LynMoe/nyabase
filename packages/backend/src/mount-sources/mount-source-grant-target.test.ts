import { describe, expect, it } from 'vitest';
import {
  parseMountSourceGrantTarget,
  zMountSourceGrantTarget,
} from './mount-source-grant-target.js';

describe('mount source grant target contract', () => {
  it('requires serverId for local grants', () => {
    expect(() => zMountSourceGrantTarget.parse({
      sourceKind: 'local',
      sourceId: 'disk-a',
    })).toThrow();
    expect(parseMountSourceGrantTarget('local', 'disk-a', 'server-a')).toEqual({
      sourceKind: 'local',
      sourceId: 'disk-a',
      serverId: 'server-a',
    });
  });

  it('forbids serverId for remote grants', () => {
    expect(() => parseMountSourceGrantTarget('remote', 'remote-a', 'server-a')).toThrow();
    expect(parseMountSourceGrantTarget('remote', 'remote-a', undefined)).toEqual({
      sourceKind: 'remote',
      sourceId: 'remote-a',
    });
  });

  it('bounds every route-derived resource identity', () => {
    expect(() => parseMountSourceGrantTarget('local', 'x'.repeat(129), 'server-a')).toThrow();
    expect(() => parseMountSourceGrantTarget('local', 'disk-a', 'x'.repeat(129))).toThrow();
    expect(() => parseMountSourceGrantTarget('remote', 'x'.repeat(129), undefined)).toThrow();
    expect(() => parseMountSourceGrantTarget('local', '../disk-a', 'server-a')).toThrow();
    expect(() => parseMountSourceGrantTarget('local', 'disk-a', 'server/a')).toThrow();
    expect(() => parseMountSourceGrantTarget('remote', '\nremote-a', undefined)).toThrow();
  });
});
