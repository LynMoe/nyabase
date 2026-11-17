import {
  CONTAINER_SCRIPT_GUEST_RUNS_DIR,
  CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES,
  type ContainerScriptFileDestination,
} from '@nyabase/common';

/*
 * The guest side of one run. The Backend pushes `script`, `files/<name>` and
 * this wrapper into `<runs dir>/<run id>/` and executes the wrapper as root.
 * The wrapper:
 *
 *  1. holds the guest lock (flock on `<runs dir>/.lock`), so a run left over
 *     from before a Backend restart never overlaps the next one;
 *  2. waits (up to 120 s) for systemd to finish booting;
 *  3. installs each file with a destination (install into `<path>.nyabase-tmp`
 *     with its mode and owner, then mv over the path: an atomic replace);
 *  4. runs the script under `timeout -k 30 <timeout>` (killing its process
 *     group), with the NYABASE_* environment, stdin from /dev/null, and only
 *     the last CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES of stdout + stderr kept;
 *  5. writes `output`, then `timed_out` when the timeout fired, then `rc`
 *     (renamed into place last: a present `rc` means the rest is complete).
 *
 * The run directory sits on the root filesystem, not under /run (a tmpfs the
 * guest mounts while booting), and survives a Backend restart: `rc` is how a
 * restarted Backend learns how a run it lost track of ended.
 */

export const GUEST_LOCK_BUSY_EXIT = 121;
export const GUEST_INSTALL_FAILED_EXIT = 126;
export const GUEST_NO_RESULT_EXIT = 125;
/** How long the wrapper waits for systemd before running the script anyway. */
export const GUEST_BOOT_WAIT_SECONDS = 120;
/** Grace `timeout -k` gives the script after SIGTERM before SIGKILL. */
export const GUEST_KILL_AFTER_SECONDS = 30;

export interface WrapperFile {
  readonly name: string;
  readonly destination: ContainerScriptFileDestination | null;
}

export interface WrapperInput {
  readonly runId: string;
  readonly timeoutSeconds: number;
  readonly files: readonly WrapperFile[];
  /** NYABASE_* variables exported to the script. */
  readonly environment: Readonly<Record<string, string>>;
  /** Tests run the wrapper in a scratch directory; the guest always uses the default. */
  readonly runsDirectory?: string;
}

export function guestRunDirectory(runId: string, runsDirectory = CONTAINER_SCRIPT_GUEST_RUNS_DIR): string {
  return `${runsDirectory}/${runId}`;
}

/** A POSIX shell word that stands for exactly `value`. */
export function shellQuote(value: string): string {
  if (value.includes('\u0000')) throw new Error('A shell word cannot contain NUL');
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const ENVIRONMENT_NAME = /^NYABASE_[A-Z0-9_]+$/;

function installLine(file: WrapperFile): string | null {
  const destination = file.destination;
  if (!destination) return null;
  const source = `"$dir/files/"${shellQuote(file.name)}`;
  const target = shellQuote(destination.path);
  const owner = destination.owner === 'root'
    ? '-o 0 -g 0'
    : '-o "$NYABASE_LOGIN_USER" -g "$(id -g "$NYABASE_LOGIN_USER")"';
  const failed = shellQuote(`nyabase: could not install ${destination.path}`);
  return [
    `  mkdir -p "$(dirname ${target})" &&`,
    `    install -m ${destination.mode} ${owner} ${source} ${target}'.nyabase-tmp' &&`,
    `    mv -f ${target}'.nyabase-tmp' ${target} ||`,
    `    { rm -f ${target}'.nyabase-tmp'; echo ${failed} >&2; echo ${GUEST_INSTALL_FAILED_EXIT} > "$dir/rc.tmp"; exit 0; }`,
  ].join('\n');
}

export function buildWrapper(input: WrapperInput): string {
  if (!/^[0-9a-f-]{36}$/.test(input.runId)) throw new Error('run id must be a UUID');
  const timeout = Math.trunc(input.timeoutSeconds);
  const exportLines = Object.entries(input.environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!ENVIRONMENT_NAME.test(name)) throw new Error(`invalid environment name ${name}`);
      return `  export ${name}=${shellQuote(value)}`;
    });
  const installs = input.files.map(installLine).filter((line): line is string => line !== null);
  const runsDirectory = input.runsDirectory ?? CONTAINER_SCRIPT_GUEST_RUNS_DIR;
  const runs = shellQuote(runsDirectory);
  return [
    '#!/bin/sh',
    `# nyabase container script run ${input.runId} (generated; removed after the run)`,
    `dir=${shellQuote(guestRunDirectory(input.runId, runsDirectory))}`,
    `cd "$dir" || exit ${GUEST_NO_RESULT_EXIT}`,
    'rm -f rc rc.tmp rc.final output output.tmp timed_out',
    `exec 9>${runs}/.lock`,
    'if command -v flock >/dev/null 2>&1; then',
    `  if ! flock -w ${timeout} 9; then`,
    "    echo 'nyabase: another container script run still holds the guest lock' > output",
    `    echo ${GUEST_LOCK_BUSY_EXIT} > rc.final && mv -f rc.final rc`,
    `    exit ${GUEST_LOCK_BUSY_EXIT}`,
    '  fi',
    'fi',
    `find ${runs} -mindepth 1 -maxdepth 1 -type d -mtime +7 ! -name ${shellQuote(input.runId)} -exec rm -rf {} + 2>/dev/null`,
    'if command -v systemctl >/dev/null 2>&1; then',
    `  timeout ${GUEST_BOOT_WAIT_SECONDS} systemctl is-system-running --wait >/dev/null 2>&1`,
    'fi',
    'started=$(date +%s)',
    '(',
    ...exportLines,
    '  export HOME=/root',
    ...installs,
    '  cd /root 2>/dev/null || cd /',
    `  timeout -k ${GUEST_KILL_AFTER_SECONDS} ${timeout} "$dir/script" </dev/null`,
    '  echo $? > "$dir/rc.tmp"',
    `) 2>&1 | tail -c ${CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES} > "$dir/output.tmp"`,
    'mv -f "$dir/output.tmp" "$dir/output"',
    `rc=$(cat "$dir/rc.tmp" 2>/dev/null || echo ${GUEST_NO_RESULT_EXIT})`,
    'rm -f "$dir/rc.tmp"',
    'case "$rc" in',
    `  124|137) if [ $(( $(date +%s) - started )) -ge ${timeout} ]; then : > "$dir/timed_out"; fi ;;`,
    'esac',
    'echo "$rc" > "$dir/rc.final" && mv -f "$dir/rc.final" "$dir/rc"',
    'exit 0',
    '',
  ].join('\n');
}
