export const VOLUME_ADOPT_FAIL_AFTER_ATTEMPTS = 8;

export interface VolumePlacementRow {
  readonly volume_id: string;
  readonly server_id: string;
  readonly pool_id: string;
  readonly desired_present: boolean;
  readonly observed_present: boolean;
  readonly observed_generation: number | null;
  readonly unused_confirmed_at: Date | string | null;
}

const TERMINAL_CONTAINER_PHASES = new Set(['failed', 'deleting']);

export function placementServersToDesire(input: {
  readonly lifecyclePhase: string;
  readonly serverId: string | null;
  readonly homeServerId: string;
  readonly liveAttachmentServerIds: readonly string[];
}): ReadonlySet<string> {
  if (input.lifecyclePhase === 'deleting') return new Set();
  if (input.serverId) return new Set([input.serverId]);
  if (input.lifecyclePhase === 'failed') return new Set([input.homeServerId]);
  return new Set([input.homeServerId, ...input.liveAttachmentServerIds]);
}

export function isLiveUndrainedAttachment(input: {
  readonly detachDrainedAt: Date | string | null;
  readonly containerPhase: string;
}): boolean {
  return input.detachDrainedAt === null && !TERMINAL_CONTAINER_PHASES.has(input.containerPhase);
}
