import type {
  ContainerScriptCounts,
  ContainerScriptDto,
  ContainerScriptRunStatus,
  ContainerScriptTargetState,
  ContainerScriptVersionDto,
} from '@nyabase/common';
import { Badge } from '../ui/badge.js';
import { Hint } from '../ui/hint.js';
import { StatusBadge } from '../layout/status-badge.js';
import {
  countEntries,
  runStatusBadge,
  scriptStatusBadge,
  scriptTriggerBadges,
  targetStateBadge,
  TARGET_STATE_HINTS,
  type ScriptBadgeTone,
} from '../../lib/container-scripts.js';

/** StatusBadge has no info tone; running reads as in progress through its spinner. */
function statusTone(tone: ScriptBadgeTone): 'success' | 'secondary' | 'destructive' | 'warning' {
  return tone === 'info' ? 'secondary' : tone;
}

export function TriggerBadges({
  script,
  version,
}: {
  script: Pick<ContainerScriptDto, 'everyBoot'>;
  version: Pick<ContainerScriptVersionDto, 'applyNow' | 'onNewContainers'>;
}) {
  const badges = scriptTriggerBadges(script, version);
  if (badges.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((badge) => (
        <Badge key={badge.key} variant={badge.key === 'boot' ? 'info' : 'outline'}>{badge.label}</Badge>
      ))}
    </span>
  );
}

export function ScriptStatusBadge({ script }: { script: Pick<ContainerScriptDto, 'status' | 'pauseReason'> }) {
  const badge = scriptStatusBadge(script);
  return <Badge variant={badge.tone} data-testid="container-script-status">{badge.label}</Badge>;
}

export function TargetStateBadge({ state }: { state: ContainerScriptTargetState }) {
  const badge = targetStateBadge(state);
  return (
    <Hint content={TARGET_STATE_HINTS[state]}>
      <span tabIndex={0} className="inline-flex">
        <StatusBadge label={badge.label} raw={state} pending={badge.pending} variant={statusTone(badge.tone)} />
      </span>
    </Hint>
  );
}

export function RunStatusBadge({ status }: { status: ContainerScriptRunStatus }) {
  const badge = runStatusBadge(status);
  return <StatusBadge label={badge.label} raw={status} pending={badge.pending} variant={statusTone(badge.tone)} />;
}

/** `成功 12 · 失败 1 · 执行中 2`: the non-zero states of the current version. */
export function CountsSummary({ counts, empty = '暂无容器' }: { counts: ContainerScriptCounts; empty?: string }) {
  const entries = countEntries(counts);
  if (entries.length === 0) return <span className="text-sm text-muted-foreground">{empty}</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      {entries.map(({ state, count }) => {
        const badge = targetStateBadge(state);
        const color = badge.tone === 'success'
          ? 'text-success'
          : badge.tone === 'destructive'
            ? 'text-destructive'
            : badge.tone === 'warning' ? 'text-warning' : badge.tone === 'info' ? 'text-info' : 'text-muted-foreground';
        return (
          <span key={state} className="whitespace-nowrap">
            <span className={color}>{badge.label}</span>
            <span className="ml-1 font-medium tabular-nums">{count}</span>
          </span>
        );
      })}
    </span>
  );
}
