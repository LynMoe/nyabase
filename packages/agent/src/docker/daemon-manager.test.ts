import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateDockerResourceLimitPlan } from './resource-limits.js';
import {
  DaemonDockerProbeTimeoutError,
  assertDockerDaemonIdentity,
  renderDockerLimitSliceFile,
  renderUnitFile,
  waitForDockerSocket,
  withDaemonDockerDeadline,
} from './daemon-manager.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('DaemonManager unit rendering', () => {
  it('requires the live daemon to use the exact root and overlay2', () => {
    expect(() => assertDockerDaemonIdentity('/var/lib/nyabase-docker', {
      DockerRootDir: '/var/lib/nyabase-docker', Driver: 'overlay2',
    })).not.toThrow();
    expect(() => assertDockerDaemonIdentity('/var/lib/nyabase-docker', {
      DockerRootDir: '/var/lib/docker', Driver: 'overlay2',
    })).toThrow('data-root mismatch');
    expect(() => assertDockerDaemonIdentity('/var/lib/nyabase-docker', {
      DockerRootDir: '/var/lib/nyabase-docker', Driver: 'btrfs',
    })).toThrow('storage driver mismatch');
  });

  it('renders cgroup parent and slice directives when host Docker limits are enabled', () => {
    const plan = calculateDockerResourceLimitPlan(
      { enabled: true },
      { cpuCores: 12, totalMemBytes: 100 * 1024 ** 3 },
    );

    const service = renderUnitFile('/var/lib/nyabase-docker', false, plan);
    const slice = renderDockerLimitSliceFile(plan);

    expect(service).toContain('Slice=nyabase-docker-limit.slice');
    expect(service).toContain('Delegate=yes');
    expect(service).toContain('--cgroup-parent=nyabase-docker-limit.slice');
    expect(service).toContain('--exec-opt native.cgroupdriver=systemd');
    expect(service).toContain('KillMode=control-group');
    expect(service).toContain('TimeoutStopSec=30s');
    expect(service).toContain('SendSIGKILL=yes');
    expect(slice).toContain('CPUQuota=1100%');
    expect(slice).toContain(`MemoryHigh=${Math.floor(90 * 1024 ** 3 * 0.9)}`);
    expect(slice).toContain(`MemoryMax=${90 * 1024 ** 3}`);
  });

  it('omits CPUQuota for hosts below 12 logical cores', () => {
    const plan = calculateDockerResourceLimitPlan(
      { enabled: true },
      { cpuCores: 8, totalMemBytes: 100 * 1024 ** 3 },
    );

    expect(renderDockerLimitSliceFile(plan)).not.toContain('CPUQuota=');
  });

  it('does not render limit directives when host Docker limits are disabled', () => {
    const plan = calculateDockerResourceLimitPlan(
      { enabled: false },
      { cpuCores: 36, totalMemBytes: 100 * 1024 ** 3 },
    );

    const service = renderUnitFile('/var/lib/nyabase-docker', false, plan);

    expect(service).not.toContain('Slice=nyabase-docker-limit.slice');
    expect(service).not.toContain('--cgroup-parent=nyabase-docker-limit.slice');
    expect(renderDockerLimitSliceFile(plan)).toBeNull();
  });

  it('bounds a never-settling unary Docker daemon probe', async () => {
    vi.useFakeTimers();
    const probe = withDaemonDockerDeadline(
      new Promise<never>(() => {}),
      25,
      'test probe',
    );
    const outcome = expect(probe).rejects.toBeInstanceOf(DaemonDockerProbeTimeoutError);

    await vi.advanceTimersByTimeAsync(25);
    await outcome;
  });

  it('bounds startup even when every socket ping never settles', async () => {
    vi.useFakeTimers();
    const ping = vi.fn(() => new Promise<never>(() => {}));
    const wait = waitForDockerSocket(ping, {
      waitTimeoutMs: 30,
      probeTimeoutMs: 10,
      pollIntervalMs: 5,
      description: 'test dockerd socket',
    });
    const outcome = expect(wait).rejects.toThrow('Timed out waiting 0.03s for test dockerd socket');

    await vi.advanceTimersByTimeAsync(30);
    await outcome;
    expect(ping).toHaveBeenCalledTimes(2);
  });
});
