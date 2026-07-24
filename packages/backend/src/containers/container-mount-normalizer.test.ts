import { describe, expect, it } from 'vitest';
import { MAX_CONTAINER_MOUNTS } from '@nyabase/common';
import { normalizeContainerMounts } from './container-mount-normalizer.js';

const mount = (overrides: Record<string, unknown> = {}) => ({
  sourceKind: 'local',
  sourceId: 'disk-a',
  dirName: 'workspace',
  containerPath: '/workspace',
  ...overrides,
});

describe('normalizeContainerMounts', () => {
  it('uses the same strict consumed-field boundary for legacy durable rows', () => {
    expect(normalizeContainerMounts([mount({
      id: 'legacy-derived-id',
      containerPath: '//workspace//data',
    })])).toEqual([{
      sourceKind: 'local',
      sourceId: 'disk-a',
      dirName: 'workspace',
      containerPath: '/workspace/data',
      id: 'local:disk-a:workspace:/workspace/data',
    }]);
  });

  it.each([
    null,
    {},
    [mount({ sourceKind: 'host' })],
    [mount({ sourceId: '' })],
    [mount({ dirName: '../escape' })],
    [mount({ containerPath: '/../escape' })],
    [mount({ containerPath: '/bad\npath' })],
    [mount({ ignoredField: '/host/private/path' })],
  ])('fails closed for malformed persisted input %#', (value) => {
    expect(() => normalizeContainerMounts(value)).toThrow('Invalid container mount');
  });

  it.each(['/', '//', '///'])('rejects persisted root mount spelling %j', (containerPath) => {
    expect(() => normalizeContainerMounts([mount({ containerPath })]))
      .toThrow(/mount path must not be root|Invalid container mount/);
  });

  it('rejects capacity and canonical duplicate identities', () => {
    expect(() => normalizeContainerMounts(Array.from(
      { length: MAX_CONTAINER_MOUNTS + 1 },
      (_, index) => mount({ dirName: `dir-${index}`, containerPath: `/dir-${index}` }),
    ))).toThrow(`At most ${MAX_CONTAINER_MOUNTS}`);
    expect(() => normalizeContainerMounts([
      mount({ containerPath: '/workspace//data' }),
      mount({ dirName: 'other', containerPath: '/workspace/data' }),
    ])).toThrow('Duplicate container mount path');
    expect(() => normalizeContainerMounts([
      mount(),
      mount({ containerPath: '/other' }),
    ])).toThrow('Duplicate mount source directory');
  });
});
