import * as fs from 'fs/promises';
import type { DockerClient, ResolvedContainerMountSpec } from '../../docker/docker-client.js';

export type ContainerMountObservation = { dst: string; src: string };

export class ContainerMountMismatchError extends Error {
  constructor(message: string, readonly observed: ContainerMountObservation[]) {
    super(message);
    this.name = 'ContainerMountMismatchError';
  }
}

/**
 * Docker-native bind mounts are immutable for the lifetime of a runtime.
 * This reconciler therefore observes and verifies only; it never enters a
 * container mount namespace and has no PID-based mutation path.
 */
export class ContainerMountReconciler {
  constructor(private readonly docker: DockerClient) {}

  async ensure(runtimeId: string, expected: ResolvedContainerMountSpec[]): Promise<{ current: ContainerMountObservation[] }> {
    const current = await this.observe(runtimeId);
    await this.assertExpected(expected, current);
    return { current };
  }

  async verify(runtimeId: string, expected: ResolvedContainerMountSpec[]): Promise<void> {
    await this.assertExpected(expected, await this.observe(runtimeId));
  }

  async observe(runtimeId: string): Promise<ContainerMountObservation[]> {
    const inspect = await this.docker.inspectContainer(runtimeId);
    return (inspect.Mounts ?? [])
      .filter((mount) => mount.Type === 'bind' && Boolean(mount.Source) && Boolean(mount.Destination))
      .map((mount) => ({ src: mount.Source, dst: mount.Destination }));
  }

  private async assertExpected(
    expected: ResolvedContainerMountSpec[],
    actual: ContainerMountObservation[],
  ): Promise<void> {
    const byDestination = new Map(actual.map((entry) => [entry.dst, entry]));
    const expectedDestinations = new Set(expected.map((mount) => mount.containerPath));
    for (const entry of actual) {
      if (!expectedDestinations.has(entry.dst)) {
        throw new ContainerMountMismatchError(`Unexpected bind mount at ${entry.dst}`, actual);
      }
    }
    for (const mount of expected) {
      const entry = byDestination.get(mount.containerPath);
      if (!entry) throw new ContainerMountMismatchError(`Mount ${mount.containerPath} is missing`, actual);
      if (!await this.sameRealPath(mount.hostPath, entry.src)) {
        throw new ContainerMountMismatchError(
          `Mount ${mount.containerPath} has unexpected source ${entry.src}`,
          actual,
        );
      }
    }
  }

  private async sameRealPath(left: string, right: string): Promise<boolean> {
    try {
      const [resolvedLeft, resolvedRight] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
      return resolvedLeft === resolvedRight;
    } catch {
      return false;
    }
  }
}
