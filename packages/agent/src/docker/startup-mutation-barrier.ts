import {
  createIsolatedCommandRunner,
  PhysicalMutationFenceBusyError,
  type IsolatedCommandRunner,
} from '../fs/isolated-command.js';
import { NYABASE_DOCKER_UNIT_NAME } from './daemon-manager.js';

export const STARTUP_DOCKER_QUIESCE_TIMEOUT_MS = 90_000;
const STARTUP_DOCKER_FENCE_RETRY_MS = 100;

/**
 * `systemctl stop` is not the proof by itself. The helper keeps the stable
 * physical-mutation flock while it freshly proves that the unit has no main
 * process and no remaining process in its v1/v2 service cgroup. All children
 * inherit the flock fd, so a D-state systemctl/find/cat also fences a new Agent.
 */
const STARTUP_DOCKER_QUIESCE_SCRIPT = String.raw`
set -u
export LC_ALL=C
unit=$1
systemctl_path=$2
cgroup_root=$3
max_attempts=$4
poll_seconds=$5

# A failed stop response may only be accepted when the fresh proof below says
# the physical daemon is already fully quiesced.
"$systemctl_path" stop "$unit" >/dev/null 2>&1 || :
# Upgrade safety: an already-loaded old unit may still use KillMode=process.
# Force every residual daemon/control-plane descendant out of that cgroup
# before judging the fresh state. A not-yet-installed unit safely rejects this.
"$systemctl_path" kill --kill-whom=all --signal=SIGKILL "$unit" >/dev/null 2>&1 || :

prove_quiesced() {
  show=$("$systemctl_path" show "$unit" \
    --property=LoadState,ActiveState,SubState,MainPID,ControlGroup \
    --no-pager) || return 1

  active=$(printf '%s\n' "$show" | sed -n 's/^ActiveState=//p' | tail -n 1)
  main_pid=$(printf '%s\n' "$show" | sed -n 's/^MainPID=//p' | tail -n 1)
  control_group=$(printf '%s\n' "$show" | sed -n 's/^ControlGroup=//p' | tail -n 1)

  case "$active" in inactive|failed) ;; *) return 1 ;; esac
  case "$main_pid" in 0|'') ;; *) return 1 ;; esac
  case "$cgroup_root" in /*) ;; *) return 1 ;; esac
  case "$control_group" in
    '') control_group="/system.slice/$unit" ;;
    /*) ;;
    *) return 1 ;;
  esac

  # Unified cgroup v2 stores the unit directly below cgroup_root. Hybrid/v1
  # layouts store it once per controller, hence both candidates are checked.
  for group_dir in "$cgroup_root$control_group" "$cgroup_root"/*"$control_group"; do
    [ -d "$group_dir" ] || continue
    remaining=$(find "$group_dir" -type f \( -name cgroup.procs -o -name tasks \) \
      -exec cat {} + 2>/dev/null) || return 1
    [ -z "$remaining" ] || return 1
  done
  return 0
}

attempt=0
while [ "$attempt" -lt "$max_attempts" ]; do
  prove_quiesced && exit 0
  attempt=$((attempt + 1))
  sleep "$poll_seconds"
done
exit 76
`;

export interface StartupDockerMutationBarrierOptions {
  physicalMutationLockPath?: string;
  runCommand?: IsolatedCommandRunner;
  systemctlPath?: string;
  cgroupRoot?: string;
  unitName?: string;
  timeoutMs?: number;
  /** Test seam for bounded negative-proof cases. */
  proofAttempts?: number;
  /** Test seam for bounded negative-proof cases. */
  proofPollSeconds?: number;
}

export interface StartupDockerQuiesceCommand {
  executable: '/bin/sh';
  args: string[];
}

export function startupDockerQuiesceCommand(
  options: StartupDockerMutationBarrierOptions = {},
): StartupDockerQuiesceCommand {
  const systemctlPath = options.systemctlPath ?? '/usr/bin/systemctl';
  const cgroupRoot = options.cgroupRoot ?? '/sys/fs/cgroup';
  const unitName = options.unitName ?? NYABASE_DOCKER_UNIT_NAME;
  const proofAttempts = options.proofAttempts ?? 300;
  const proofPollSeconds = options.proofPollSeconds ?? 0.1;
  if (!systemctlPath.startsWith('/') || systemctlPath.includes('\0')) {
    throw new Error(`Invalid systemctl path: ${systemctlPath}`);
  }
  if (!cgroupRoot.startsWith('/') || cgroupRoot.includes('\0')) {
    throw new Error(`Invalid cgroup root: ${cgroupRoot}`);
  }
  if (!/^[A-Za-z0-9_.@-]+\.service$/.test(unitName)) {
    throw new Error(`Invalid Docker unit name: ${unitName}`);
  }
  if (!Number.isSafeInteger(proofAttempts) || proofAttempts <= 0 || proofAttempts > 10_000) {
    throw new Error(`Invalid Docker quiesce proof attempt count: ${String(proofAttempts)}`);
  }
  if (!Number.isFinite(proofPollSeconds) || proofPollSeconds <= 0 || proofPollSeconds > 10) {
    throw new Error(`Invalid Docker quiesce proof poll interval: ${String(proofPollSeconds)}`);
  }
  return {
    executable: '/bin/sh',
    args: [
      '-eu',
      '-c',
      STARTUP_DOCKER_QUIESCE_SCRIPT,
      'nyabase-docker-startup-quiesce',
      unitName,
      systemctlPath,
      cgroupRoot,
      String(proofAttempts),
      String(proofPollSeconds),
    ],
  };
}

/**
 * Mandatory boot barrier. Success means an old dockerd mutation can no longer
 * commit; failure means this Agent must exit before daemon reconcile or WS.
 */
export async function quiesceDockerBeforeAgentStartup(
  options: StartupDockerMutationBarrierOptions = {},
): Promise<void> {
  const command = startupDockerQuiesceCommand(options);
  const runner = options.runCommand ?? createIsolatedCommandRunner({
    lockPath: options.physicalMutationLockPath,
  });
  const timeoutMs = options.timeoutMs ?? STARTUP_DOCKER_QUIESCE_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid Docker startup quiesce timeout: ${String(timeoutMs)}`);
  }

  // A replacement Agent commonly reaches this barrier while a detached
  // helper from the killed process still owns the stable physical flock. That
  // is positive serialization evidence, not a bootstrap/inventory failure.
  // Retry only this proved-no-effect conflict within one bounded deadline;
  // every other error keeps its existing fail-closed meaning.
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const remainingMs = Math.ceil(deadline - performance.now());
    if (remainingMs <= 0) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the previous Agent physical mutation helper`,
      );
    }
    try {
      await runner(command.executable, command.args, remainingMs);
      return;
    } catch (error) {
      if (!(error instanceof PhysicalMutationFenceBusyError)) throw error;
      const retryRemainingMs = Math.ceil(deadline - performance.now());
      if (retryRemainingMs <= 0) {
        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for the previous Agent physical mutation helper`,
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(STARTUP_DOCKER_FENCE_RETRY_MS, retryRemainingMs));
      });
    }
  }
}
