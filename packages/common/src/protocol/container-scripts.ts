import { z } from 'zod';

/*
 * Container scripts: an administrator's script (plus files) that the platform
 * runs as root inside containers. A script has a scope (which containers) and
 * triggers (when):
 *
 *  - applyNow       — on publishing a version, the containers in scope now;
 *  - onNewContainers — containers that enter the scope after the publish;
 *  - everyBoot      — after every boot of a container in scope (a new
 *                     container's first boot is a boot, so it implies
 *                     onNewContainers). Fixed when the script is created.
 *
 * A script that is not everyBoot runs once per container: a container that
 * succeeded with an earlier version only runs again for a version published
 * with applyNow. On one container, runs never overlap and the lowest priority
 * number goes first; a failed script does not hold back the next one.
 */

export const CONTAINER_SCRIPT_PRIORITY_MIN = 1;
export const CONTAINER_SCRIPT_PRIORITY_MAX = 1_000_000;
/** Gap left after the current highest priority when a create names none. */
export const CONTAINER_SCRIPT_PRIORITY_STEP = 10;
export const CONTAINER_SCRIPT_MAX_SCRIPT_BYTES = 64 * 1024;
export const CONTAINER_SCRIPT_MAX_FILES = 32;
/** One uploaded file, and every file of one version together. */
export const CONTAINER_SCRIPT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES = 16 * 1024 * 1024;
export const CONTAINER_SCRIPT_TIMEOUT_MIN_SECONDS = 10;
export const CONTAINER_SCRIPT_TIMEOUT_MAX_SECONDS = 24 * 60 * 60;
export const CONTAINER_SCRIPT_DEFAULT_TIMEOUT_SECONDS = 600;
export const CONTAINER_SCRIPT_MAX_ATTEMPTS_LIMIT = 10;
export const CONTAINER_SCRIPT_DEFAULT_MAX_ATTEMPTS = 3;
export const CONTAINER_SCRIPT_DEFAULT_PAUSE_AFTER_FAILURES = 3;
/** The end of a run's combined stdout + stderr that is kept. */
export const CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES = 64 * 1024;
/** Runs kept per (script, container); older ones are pruned. */
export const CONTAINER_SCRIPT_RUNS_KEPT = 20;
/** Where a run's script, files and results live in the guest while it runs. */
export const CONTAINER_SCRIPT_GUEST_RUNS_DIR = '/var/lib/nyabase/script-runs';
/** Guest paths a file may not be installed under. */
export const CONTAINER_SCRIPT_FORBIDDEN_PATH_PREFIXES = ['/proc', '/sys', '/dev', CONTAINER_SCRIPT_GUEST_RUNS_DIR] as const;
/** Upload route; the reverse proxy must admit CONTAINER_SCRIPT_MAX_FILE_BYTES bodies on it. */
export const CONTAINER_SCRIPT_BLOB_UPLOAD_PATH = '/admin/container-scripts/blobs';

export const ContainerScriptStatus = {
  Active: 'active',
  Paused: 'paused',
  Archived: 'archived',
} as const;
export type ContainerScriptStatus = typeof ContainerScriptStatus[keyof typeof ContainerScriptStatus];

/** Why a script is paused: by an administrator, after its canary, or after too many failures. */
export const ContainerScriptPauseReason = {
  Manual: 'manual',
  Canary: 'canary',
  Failures: 'failures',
} as const;
export type ContainerScriptPauseReason = typeof ContainerScriptPauseReason[keyof typeof ContainerScriptPauseReason];

/**
 * Where one container stands with one script (for everyBoot: with its current boot).
 *  pending   — due, will run once the container is running and a slot is free;
 *  waiting   — due, but the container is not running (stopped, provisioning, unobserved);
 *  running   — a run is in progress;
 *  succeeded — done (once: the version in `version`; everyBoot: this boot);
 *  failed    — the attempts are used up; an administrator can retry;
 *  skipped   — applyNow found it stopped and the version said skip;
 *  exempt    — not asked to run (it existed when a version without applyNow was published).
 */
export const ContainerScriptTargetState = {
  Pending: 'pending',
  Waiting: 'waiting',
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  Skipped: 'skipped',
  Exempt: 'exempt',
} as const;
export type ContainerScriptTargetState = typeof ContainerScriptTargetState[keyof typeof ContainerScriptTargetState];
export const CONTAINER_SCRIPT_TARGET_STATES = Object.values(ContainerScriptTargetState);

export const ContainerScriptRunStatus = {
  Running: 'running',
  Succeeded: 'succeeded',
  Failed: 'failed',
  TimedOut: 'timed_out',
  /** The run's outcome is unknown: the container rebooted or stopped, or the Backend lost it. */
  Interrupted: 'interrupted',
} as const;
export type ContainerScriptRunStatus = typeof ContainerScriptRunStatus[keyof typeof ContainerScriptRunStatus];

/** What made a container due; the guest sees it as NYABASE_TRIGGER. */
export const ContainerScriptTrigger = {
  Now: 'now',
  NewContainer: 'new_container',
  Boot: 'boot',
  Retry: 'retry',
} as const;
export type ContainerScriptTrigger = typeof ContainerScriptTrigger[keyof typeof ContainerScriptTrigger];

/** applyNow and a container that is stopped: run it after its next start, or skip it. */
export const ContainerScriptStoppedPolicy = {
  Wait: 'wait',
  Skip: 'skip',
} as const;
export type ContainerScriptStoppedPolicy = typeof ContainerScriptStoppedPolicy[keyof typeof ContainerScriptStoppedPolicy];

/** Who owns an installed file: root, or the image's login user of that container. */
export const ContainerScriptFileOwner = {
  Root: 'root',
  LoginUser: 'login_user',
} as const;
export type ContainerScriptFileOwner = typeof ContainerScriptFileOwner[keyof typeof ContainerScriptFileOwner];

// --- validation -------------------------------------------------------------------

const utf8Length = (value: string): number => new TextEncoder().encode(value).length;

/** Why a guest path cannot take an installed file. */
export type ContainerScriptPathIssue =
  | { readonly code: 'not_absolute' | 'too_long' | 'control_characters' | 'directory' | 'empty_segment' | 'dot_segment' }
  | { readonly code: 'forbidden_prefix'; readonly prefix: string };

/** Whether a file may be installed at this absolute guest path; null when it may. */
export function containerScriptPathIssue(path: string): ContainerScriptPathIssue | null {
  if (!path.startsWith('/')) return { code: 'not_absolute' };
  if (path.length > 1_024) return { code: 'too_long' };
  if (/[\u0000-\u001f\u007f]/.test(path)) return { code: 'control_characters' };
  if (path.endsWith('/')) return { code: 'directory' };
  if (path.includes('//')) return { code: 'empty_segment' };
  if (path.split('/').some((segment) => segment === '.' || segment === '..')) return { code: 'dot_segment' };
  for (const prefix of CONTAINER_SCRIPT_FORBIDDEN_PATH_PREFIXES) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return { code: 'forbidden_prefix', prefix };
  }
  return null;
}

const PATH_ISSUE_TEXT: Record<Exclude<ContainerScriptPathIssue['code'], 'forbidden_prefix'>, string> = {
  not_absolute: 'must be an absolute path',
  too_long: 'is too long',
  control_characters: 'contains control characters',
  directory: 'must name a file, not a directory',
  empty_segment: 'contains an empty segment',
  dot_segment: 'contains . or ..',
};

/** `containerScriptPathIssue` as English text (API validation messages). */
export function containerScriptPathProblem(path: string): string | null {
  const issue = containerScriptPathIssue(path);
  if (!issue) return null;
  return issue.code === 'forbidden_prefix' ? `may not be under ${issue.prefix}` : PATH_ISSUE_TEXT[issue.code];
}

export const CONTAINER_SCRIPT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const zSha256 = z.string().regex(/^[0-9a-f]{64}$/, 'Expected a lowercase sha256 hex digest');
const zIdList = z.array(z.string().uuid()).max(4_096).transform((ids) => [...new Set(ids)].sort());

export const zContainerScriptFileDestination = z.object({
  path: z.string().superRefine((value, context) => {
    const problem = containerScriptPathProblem(value);
    if (problem) context.addIssue({ code: z.ZodIssueCode.custom, message: `path ${problem}` });
  }),
  /** Octal permission bits, for example "0644". */
  mode: z.string().regex(/^[0-7]{3,4}$/, 'Expected octal permission bits such as 0644').default('0644')
    .transform((value) => value.padStart(4, '0')),
  owner: z.enum([ContainerScriptFileOwner.Root, ContainerScriptFileOwner.LoginUser]).default(ContainerScriptFileOwner.Root),
}).strict();
export type ContainerScriptFileDestination = z.infer<typeof zContainerScriptFileDestination>;

/**
 * A file of a version: uploaded content (by sha256), copied into the run's
 * files directory ($NYABASE_FILES_DIR/<name>) and, with a destination,
 * installed there (atomically replaced) before the script starts.
 */
export const zContainerScriptFileSpec = z.object({
  name: z.string().regex(CONTAINER_SCRIPT_FILE_NAME_PATTERN, 'Use letters, digits, ".", "_" and "-" (up to 128)'),
  sha256: zSha256,
  destination: zContainerScriptFileDestination.nullable().default(null),
}).strict();
export type ContainerScriptFileSpec = z.infer<typeof zContainerScriptFileSpec>;

/**
 * Which containers a version applies to. `all`, or every non-empty list must
 * match (a list matches when it contains the container's server / image /
 * owner / id); excluded containers never match. Scope uses only attributes a
 * container keeps for life, so a container never moves in or out of it.
 */
export const zContainerScriptScope = z.object({
  all: z.boolean().default(false),
  serverIds: zIdList.default([]),
  imageIds: zIdList.default([]),
  ownerIds: zIdList.default([]),
  containerIds: zIdList.default([]),
  excludeContainerIds: zIdList.default([]),
}).strict().superRefine((scope, context) => {
  const filtered = scope.serverIds.length + scope.imageIds.length + scope.ownerIds.length + scope.containerIds.length > 0;
  if (scope.all && filtered) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'all excludes the server, image, owner and container filters' });
  }
  if (!scope.all && !filtered) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Choose all containers or at least one filter' });
  }
});
export type ContainerScriptScope = z.infer<typeof zContainerScriptScope>;

/** What a container scope test needs to know of a container. */
export interface ContainerScriptScopeSubject {
  id: string;
  serverId: string;
  imageId: string;
  ownerId: string;
}

/** The same rule the Backend applies in SQL. */
export function containerScriptScopeMatches(scope: ContainerScriptScope, container: ContainerScriptScopeSubject): boolean {
  if (scope.excludeContainerIds.includes(container.id)) return false;
  if (scope.all) return true;
  const lists = [
    [scope.serverIds, container.serverId],
    [scope.imageIds, container.imageId],
    [scope.ownerIds, container.ownerId],
    [scope.containerIds, container.id],
  ] as const;
  if (lists.every(([ids]) => ids.length === 0)) return false;
  return lists.every(([ids, value]) => ids.length === 0 || ids.includes(value));
}

export const zContainerScriptBody = z.string()
  .refine((value) => value.startsWith('#!'), 'The script must start with a #! line (for example #!/bin/bash)')
  .refine((value) => !value.includes('\u0000'), 'The script may not contain NUL bytes')
  .refine((value) => utf8Length(value) <= CONTAINER_SCRIPT_MAX_SCRIPT_BYTES, `The script may be at most ${CONTAINER_SCRIPT_MAX_SCRIPT_BYTES} bytes`);

const zNullableCount = (max: number) => z.number().int().min(1).max(max).nullable();

/** The content and run settings of one version; every field is fixed once published. */
const versionFields = {
  script: zContainerScriptBody,
  files: z.array(zContainerScriptFileSpec).max(CONTAINER_SCRIPT_MAX_FILES).default([]).superRefine((files, context) => {
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const file of files) {
      if (names.has(file.name)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate file name ${file.name}` });
      names.add(file.name);
      if (file.destination) {
        if (paths.has(file.destination.path)) {
          context.addIssue({ code: z.ZodIssueCode.custom, message: `Two files install to ${file.destination.path}` });
        }
        paths.add(file.destination.path);
      }
    }
  }),
  scope: zContainerScriptScope,
  onNewContainers: z.boolean().default(false),
  applyNow: z.boolean().default(true),
  stoppedPolicy: z.enum([ContainerScriptStoppedPolicy.Wait, ContainerScriptStoppedPolicy.Skip]).default(ContainerScriptStoppedPolicy.Wait),
  timeoutSeconds: z.number().int()
    .min(CONTAINER_SCRIPT_TIMEOUT_MIN_SECONDS)
    .max(CONTAINER_SCRIPT_TIMEOUT_MAX_SECONDS)
    .default(CONTAINER_SCRIPT_DEFAULT_TIMEOUT_SECONDS),
  maxAttempts: z.number().int().min(1).max(CONTAINER_SCRIPT_MAX_ATTEMPTS_LIMIT).default(CONTAINER_SCRIPT_DEFAULT_MAX_ATTEMPTS),
  /** Runs of this script in progress at once, platform-wide / per server; null = only the global limits. */
  maxParallel: zNullableCount(1_000).default(null),
  maxParallelPerServer: zNullableCount(100).default(null),
  /** Pause after this many containers ran the version, until an administrator resumes; null = no canary. */
  canaryCount: zNullableCount(10_000).default(null),
  /** Pause once this many containers failed the version; null = never pause for failures. */
  pauseAfterFailures: zNullableCount(10_000).default(CONTAINER_SCRIPT_DEFAULT_PAUSE_AFTER_FAILURES),
  /** What changed in this version. */
  note: z.string().trim().max(512).default(''),
};

export const zContainerScriptVersionInput = z.object(versionFields).strict();
export type ContainerScriptVersionInput = z.infer<typeof zContainerScriptVersionInput>;

const zName = z.string().trim().min(1).max(128);
const zDescription = z.string().trim().max(1_024);
const zPriority = z.number().int().min(CONTAINER_SCRIPT_PRIORITY_MIN).max(CONTAINER_SCRIPT_PRIORITY_MAX);

export const zCreateContainerScriptRequest = z.object({
  name: zName,
  description: zDescription.default(''),
  /** Absent: after the current highest priority. */
  priority: zPriority.optional(),
  /** Fixed for the life of the script. */
  everyBoot: z.boolean().default(false),
  ...versionFields,
}).strict();
export type CreateContainerScriptRequest = z.infer<typeof zCreateContainerScriptRequest>;

export const zPublishContainerScriptRequest = z.object({
  expectedRevision: z.number().int().positive().safe(),
  ...versionFields,
}).strict();
export type PublishContainerScriptRequest = z.infer<typeof zPublishContainerScriptRequest>;

export const zPatchContainerScriptRequest = z.object({
  expectedRevision: z.number().int().positive().safe(),
  name: zName.optional(),
  description: zDescription.optional(),
  priority: zPriority.optional(),
}).strict().refine(
  (value) => Object.keys(value).some((key) => key !== 'expectedRevision'),
  'At least one of name, description and priority is required',
);
export type PatchContainerScriptRequest = z.infer<typeof zPatchContainerScriptRequest>;

/** pause / resume / archive. */
export const zContainerScriptActionRequest = z.object({
  expectedRevision: z.number().int().positive().safe(),
}).strict();
export type ContainerScriptActionRequest = z.infer<typeof zContainerScriptActionRequest>;

/**
 * Run the current version again: on the given containers (any state but
 * running and out of scope), or on every failed container when none are given.
 */
export const zRetryContainerScriptRequest = z.object({
  containerIds: z.array(z.string().uuid()).min(1).max(4_096).optional(),
}).strict();
export type RetryContainerScriptRequest = z.infer<typeof zRetryContainerScriptRequest>;

export const zPreviewContainerScriptRequest = z.object({
  scope: zContainerScriptScope,
}).strict();
export type PreviewContainerScriptRequest = z.infer<typeof zPreviewContainerScriptRequest>;

export const zListContainerScriptTargetsQuery = z.object({
  state: z.enum(CONTAINER_SCRIPT_TARGET_STATES as [ContainerScriptTargetState, ...ContainerScriptTargetState[]]).optional(),
}).strict();
export type ListContainerScriptTargetsQuery = z.infer<typeof zListContainerScriptTargetsQuery>;

export const zListContainerScriptRunsQuery = z.object({
  containerId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** A run id from the previous page: runs started before it. */
  before: z.string().uuid().optional(),
}).strict();
export type ListContainerScriptRunsQuery = z.infer<typeof zListContainerScriptRunsQuery>;

// --- responses -----------------------------------------------------------------

export interface ContainerScriptBlobDto {
  sha256: string;
  sizeBytes: number;
}

export interface ContainerScriptFileDto {
  name: string;
  sha256: string;
  sizeBytes: number;
  destination: ContainerScriptFileDestination | null;
}

export interface ContainerScriptPersonRef {
  id: string;
  username: string;
  displayName: string;
}

export interface ContainerScriptVersionDto {
  version: number;
  script: string;
  files: ContainerScriptFileDto[];
  scope: ContainerScriptScope;
  onNewContainers: boolean;
  applyNow: boolean;
  stoppedPolicy: ContainerScriptStoppedPolicy;
  timeoutSeconds: number;
  maxAttempts: number;
  maxParallel: number | null;
  maxParallelPerServer: number | null;
  canaryCount: number | null;
  pauseAfterFailures: number | null;
  note: string;
  publishedAt: string;
  /** null: the publisher's account is gone. */
  publishedBy: ContainerScriptPersonRef | null;
}

/** Containers in each state, for the current version (everyBoot: the current boot). */
export type ContainerScriptCounts = Record<ContainerScriptTargetState, number>;

export interface ContainerScriptDto {
  id: string;
  name: string;
  description: string;
  priority: number;
  everyBoot: boolean;
  status: ContainerScriptStatus;
  /** Set while paused. */
  pauseReason: ContainerScriptPauseReason | null;
  /** CAS token for patch / publish / pause / resume / archive. */
  revision: number;
  current: ContainerScriptVersionDto;
  counts: ContainerScriptCounts;
  createdAt: string;
  updatedAt: string;
  createdBy: ContainerScriptPersonRef | null;
}

/** Version history without the script bodies. */
export interface ContainerScriptVersionSummaryDto {
  version: number;
  note: string;
  applyNow: boolean;
  onNewContainers: boolean;
  fileCount: number;
  publishedAt: string;
  publishedBy: ContainerScriptPersonRef | null;
}

export interface ContainerScriptRunSummaryDto {
  id: string;
  version: number;
  trigger: ContainerScriptTrigger;
  attempt: number;
  status: ContainerScriptRunStatus;
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ContainerScriptTargetDto {
  containerId: string;
  containerName: string;
  serverId: string;
  serverName: string;
  owner: ContainerScriptPersonRef;
  state: ContainerScriptTargetState;
  /** The version the state refers to (once: required, or last succeeded; everyBoot: the one to run). */
  version: number | null;
  trigger: ContainerScriptTrigger | null;
  attempts: number;
  /** A failed attempt waits until then before the next one. */
  nextAttemptAt: string | null;
  lastRun: ContainerScriptRunSummaryDto | null;
  updatedAt: string;
}

export interface ContainerScriptRunDto extends ContainerScriptRunSummaryDto {
  scriptId: string;
  containerId: string;
  containerName: string;
  serverId: string;
  /** The Incus `last_used_at` of the boot the run happened in. */
  bootId: string | null;
  /** The end of the combined stdout + stderr (CONTAINER_SCRIPT_OUTPUT_TAIL_BYTES). */
  output: string;
  /** Why the run did not finish normally (platform side), if it did not. */
  error: string | null;
}

/** A run in a list: everything but the output (GET …/runs/:runId has it). */
export type ContainerScriptRunListItemDto = Omit<ContainerScriptRunDto, 'output'>;

export interface ContainerScriptRunPageDto {
  items: ContainerScriptRunListItemDto[];
  /** Pass as `before` for older runs; null on the last page. */
  nextBefore: string | null;
}

export interface ContainerScriptPreviewContainerDto {
  id: string;
  name: string;
  serverId: string;
  serverName: string;
  owner: ContainerScriptPersonRef;
  /** The container is running now (desired and observed). */
  running: boolean;
}

export interface ContainerScriptPreviewDto {
  total: number;
  running: number;
  servers: Array<{ serverId: string; serverName: string; total: number; running: number }>;
  /** At most CONTAINER_SCRIPT_PREVIEW_LIMIT, by server then name. */
  containers: ContainerScriptPreviewContainerDto[];
  truncated: boolean;
}
export const CONTAINER_SCRIPT_PREVIEW_LIMIT = 1_000;

/**
 * What a container's owner (and staff with scope=all) sees of the scripts that
 * ran or will run in it: names, state and when — never the script or output.
 */
export interface ContainerMaintenanceItemDto {
  scriptId: string;
  name: string;
  everyBoot: boolean;
  state: ContainerScriptTargetState;
  lastRun: {
    status: ContainerScriptRunStatus;
    startedAt: string;
    finishedAt: string | null;
  } | null;
}
