import type {
  EffectiveServerAccessDto,
  GraceServerAccessDto,
  LiveServerAccessDto,
} from '@nyabase/common';

/** Entries with current coverage; they alone carry quotas. */
export function liveServerAccess(servers: readonly EffectiveServerAccessDto[] | undefined): LiveServerAccessDto[] {
  return (servers ?? []).filter((access): access is LiveServerAccessDto => access.accessPhase === 'live');
}

/** Entries whose coverage lapsed and are waiting for the purge. */
export function graceServerAccess(servers: readonly EffectiveServerAccessDto[] | undefined): GraceServerAccessDto[] {
  return (servers ?? []).filter((access): access is GraceServerAccessDto => access.accessPhase === 'grace');
}
