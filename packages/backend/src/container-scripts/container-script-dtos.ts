import type {
  ContainerMaintenanceItemDto,
  ContainerScriptCounts,
  ContainerScriptDto,
  ContainerScriptFileDto,
  ContainerScriptPersonRef,
  ContainerScriptRunDto,
  ContainerScriptRunListItemDto,
  ContainerScriptTargetDto,
  ContainerScriptTargetState,
  ContainerScriptVersionDto,
  ContainerScriptVersionSummaryDto,
} from '@nyabase/common';
import { isoDate } from '../platform/domain-utils.js';
import type { TargetListRow } from './container-script-read-model.js';
import type { FileRow, ScriptRow, VersionRow } from './container-scripts.repository.js';

type People = ReadonlyMap<string, ContainerScriptPersonRef>;

const iso = (value: Date | string | null | undefined): string => isoDate(value) ?? new Date(0).toISOString();
const person = (people: People, id: string | null): ContainerScriptPersonRef | null => (id ? people.get(id) ?? null : null);

export function toFileDto(row: FileRow): ContainerScriptFileDto {
  return {
    name: row.name,
    sha256: row.sha256,
    sizeBytes: Number(row.size_bytes),
    destination: row.destination_path === null
      ? null
      : {
        path: row.destination_path,
        mode: (row.destination_mode ?? 0o644).toString(8).padStart(4, '0'),
        owner: row.destination_owner ?? 'root',
      },
  };
}

export function toVersionDto(row: VersionRow, files: readonly FileRow[], people: People): ContainerScriptVersionDto {
  return {
    version: row.version,
    script: row.script,
    files: files.map(toFileDto),
    scope: {
      all: row.scope_all,
      serverIds: row.scope_server_ids,
      imageIds: row.scope_image_ids,
      ownerIds: row.scope_owner_ids,
      containerIds: row.scope_container_ids,
      excludeContainerIds: row.scope_exclude_container_ids,
    },
    onNewContainers: row.on_new_containers,
    applyNow: row.apply_now,
    stoppedPolicy: row.stopped_policy,
    timeoutSeconds: row.timeout_seconds,
    maxAttempts: row.max_attempts,
    maxParallel: row.max_parallel,
    maxParallelPerServer: row.max_parallel_per_server,
    canaryCount: row.canary_count,
    pauseAfterFailures: row.pause_after_failures,
    note: row.note,
    publishedAt: iso(row.published_at),
    publishedBy: person(people, row.published_by),
  };
}

export function toScriptDto(
  script: ScriptRow,
  current: ContainerScriptVersionDto,
  counts: ContainerScriptCounts,
  people: People,
): ContainerScriptDto {
  return {
    id: script.id,
    name: script.name,
    description: script.description,
    priority: script.priority,
    everyBoot: script.every_boot,
    status: script.status,
    pauseReason: script.pause_reason,
    revision: script.revision,
    current,
    counts,
    createdAt: iso(script.created_at),
    updatedAt: iso(script.updated_at),
    createdBy: person(people, script.created_by),
  };
}

export function toVersionSummaryDto(row: {
  version: number;
  note: string;
  apply_now: boolean;
  on_new_containers: boolean;
  published_at: Date;
  published_by: string | null;
  file_count: number | null;
}, people: People): ContainerScriptVersionSummaryDto {
  return {
    version: row.version,
    note: row.note,
    applyNow: row.apply_now,
    onNewContainers: row.on_new_containers,
    fileCount: Number(row.file_count ?? 0),
    publishedAt: iso(row.published_at),
    publishedBy: person(people, row.published_by),
  };
}

export function toTargetDto(row: TargetListRow, everyBoot: boolean): ContainerScriptTargetDto {
  const version = !everyBoot && (row.state === 'succeeded' || row.state === 'exempt' || row.state === 'skipped')
    ? row.succeeded_version ?? row.target_version
    : row.target_version;
  return {
    containerId: row.container_id,
    containerName: row.container_name,
    serverId: row.server_id,
    serverName: row.server_name,
    owner: { id: row.owner_id, username: row.owner_username, displayName: row.owner_display_name },
    state: row.state,
    version,
    trigger: row.trigger,
    attempts: Number(row.attempts),
    nextAttemptAt: isoDate(row.next_attempt_at),
    lastRun: row.run_id === null
      ? null
      : {
        id: row.run_id,
        version: Number(row.run_version),
        trigger: row.run_trigger ?? 'now',
        attempt: Number(row.run_attempt),
        status: row.run_status ?? 'interrupted',
        exitCode: row.run_exit_code,
        startedAt: iso(row.run_started_at),
        finishedAt: isoDate(row.run_finished_at),
      },
    updatedAt: iso(row.updated_at),
  };
}

export interface RunRow {
  id: string;
  script_id: string;
  version: number;
  container_id: string;
  container_name: string;
  server_id: string;
  trigger: 'now' | 'new_container' | 'boot' | 'retry';
  attempt: number;
  boot_id: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'interrupted';
  exit_code: number | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

export function toRunListItemDto(row: RunRow): ContainerScriptRunListItemDto {
  return {
    id: row.id,
    scriptId: row.script_id,
    version: row.version,
    containerId: row.container_id,
    containerName: row.container_name,
    serverId: row.server_id,
    trigger: row.trigger,
    attempt: row.attempt,
    bootId: row.boot_id,
    status: row.status,
    exitCode: row.exit_code,
    error: row.error,
    startedAt: iso(row.started_at),
    finishedAt: isoDate(row.finished_at),
  };
}

export function toRunDto(row: RunRow & { output: string }): ContainerScriptRunDto {
  return { ...toRunListItemDto(row), output: row.output };
}

export function toMaintenanceItem(row: {
  id: string;
  name: string;
  every_boot: boolean;
  state: string | null;
  last_run: string | null;
}): ContainerMaintenanceItemDto | null {
  const lastRun = row.last_run ? JSON.parse(row.last_run) as { status: ContainerScriptRunDto['status']; startedAt: string; finishedAt: string | null } : null;
  // Exempt (never asked) and untracked containers have nothing to show unless a run happened.
  if (!lastRun && (row.state === null || row.state === 'exempt')) return null;
  return {
    scriptId: row.id,
    name: row.name,
    everyBoot: row.every_boot,
    state: (row.state ?? 'exempt') as ContainerScriptTargetState,
    lastRun: lastRun
      ? { status: lastRun.status, startedAt: iso(lastRun.startedAt), finishedAt: isoDate(lastRun.finishedAt) }
      : null,
  };
}
