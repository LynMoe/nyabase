import { LABEL } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import type { DockerClient } from './docker-client.js';
import {
  DockerPhysicalReferenceGuard,
  PhysicalReferenceGuardError,
} from './physical-reference-guard.js';

const TARGET = '/mnt/remote-fs/remote-a';

describe('DockerPhysicalReferenceGuard', () => {
  it('blocks a running managed runtime unknown to Backend that binds the exact target', async () => {
    const docker = fakeDocker([
      runtime('runtime-drift', true, [{ Type: 'bind', Source: TARGET }]),
    ]);
    const guard = new DockerPhysicalReferenceGuard(docker as unknown as DockerClient);

    await expect(guard.assertNoRunningBindReferences(TARGET)).rejects.toMatchObject({
      name: PhysicalReferenceGuardError.name,
      code: 'physical_path_referenced',
      details: {
        runtimeId: 'runtime-drift',
        sourcePath: TARGET,
        relationship: 'exact',
      },
    });
  });

  it('blocks nested bind sources and parent binds that retain the target mount', async () => {
    const nested = fakeDocker([
      runtime('runtime-nested', true, [{ Type: 'bind', Source: `${TARGET}/project/data` }]),
    ]);
    await expect(new DockerPhysicalReferenceGuard(nested as unknown as DockerClient)
      .assertNoRunningBindReferences(TARGET)).rejects.toMatchObject({
      code: 'physical_path_referenced',
      details: { relationship: 'source_inside_target' },
    });

    const parent = fakeDocker([
      runtime('runtime-parent', true, [{ Type: 'bind', Source: '/mnt/remote-fs' }]),
    ]);
    await expect(new DockerPhysicalReferenceGuard(parent as unknown as DockerClient)
      .assertNoRunningBindReferences(TARGET)).rejects.toMatchObject({
      code: 'physical_path_referenced',
      details: { relationship: 'source_contains_target' },
    });
  });

  it('fails closed when any fresh Docker inspect is uncertain', async () => {
    const listNyabaseContainers = vi.fn().mockResolvedValue([
      listed('runtime-good'),
      listed('runtime-unobservable'),
    ]);
    const inspectContainer = vi.fn().mockImplementation(async (runtimeId: string) => {
      if (runtimeId === 'runtime-unobservable') throw new Error('dockerd read timeout');
      return runtime(runtimeId, false, []).inspect;
    });
    const guard = new DockerPhysicalReferenceGuard({
      listNyabaseContainers,
      inspectContainer,
    } as unknown as DockerClient);

    await expect(guard.assertNoRunningBindReferences(TARGET)).rejects.toMatchObject({
      code: 'physical_reference_observation_failed',
      details: {
        phase: 'inspect',
        runtimeId: 'runtime-unobservable',
        cause: 'dockerd read timeout',
      },
    });
    expect(inspectContainer).toHaveBeenCalledTimes(2);
  });

  it('allows stopped references but rejects ambiguous/non-canonical bind identities', async () => {
    const stopped = fakeDocker([
      runtime('runtime-stopped', false, [{ Type: 'bind', Source: TARGET }]),
    ]);
    await expect(new DockerPhysicalReferenceGuard(stopped as unknown as DockerClient)
      .assertNoRunningBindReferences(TARGET)).resolves.toBeUndefined();

    const ambiguous = fakeDocker([
      runtime('runtime-bad-path', true, [{ Type: 'bind', Source: `${TARGET}/../remote-a/data` }]),
    ]);
    await expect(new DockerPhysicalReferenceGuard(ambiguous as unknown as DockerClient)
      .assertNoRunningBindReferences(TARGET)).rejects.toMatchObject({
      code: 'physical_reference_observation_failed',
      details: { phase: 'inspect_bind_source', runtimeId: 'runtime-bad-path' },
    });
  });
});

function listed(id: string) {
  return { Id: id, Labels: { [LABEL.MANAGED]: 'true' } };
}

function runtime(id: string, running: boolean, mounts: Array<{ Type: string; Source: string }>) {
  return {
    listed: listed(id),
    inspect: {
      Id: id,
      Config: { Labels: { [LABEL.MANAGED]: 'true' } },
      State: { Running: running },
      Mounts: mounts,
    },
  };
}

function fakeDocker(runtimes: ReturnType<typeof runtime>[]) {
  const byId = new Map(runtimes.map((entry) => [entry.listed.Id, entry.inspect]));
  return {
    listNyabaseContainers: vi.fn().mockResolvedValue(runtimes.map((entry) => entry.listed)),
    inspectContainer: vi.fn().mockImplementation(async (runtimeId: string) => byId.get(runtimeId)),
  };
}
