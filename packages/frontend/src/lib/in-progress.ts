import {
  CertificateState,
  CertificateTrustState,
  ContainerPhase,
  ContainerStatus,
  IntentStatus,
  PreflightStatus,
  ResourceLifecyclePhase,
  UserStatus,
  type ContainerDto,
  type ImageAssignmentDto,
  type ImageDto,
  type IntentDto,
  type SharedVolumeDto,
  type VolumeBindState,
  type VolumeDto,
} from '@nyabase/common';
import { currentOutstandingIntents } from './intent-visibility.js';

type ContainerProgress = {
  needsAttention: boolean;
  lifecyclePhase: ContainerDto['lifecyclePhase'];
  actual: { status: ContainerDto['actual']['status'] };
  rootSizePendingBytes: number | null;
  observedGeneration: number | null;
  generation: number;
};

type VolumeProgress = Pick<
  VolumeDto | SharedVolumeDto,
  'needsAttention' | 'lifecyclePhase' | 'observedGeneration' | 'generation'
>;

function containerBlocked(container: Pick<ContainerProgress, 'needsAttention' | 'lifecyclePhase' | 'actual'>): boolean {
  return container.needsAttention
    || container.lifecyclePhase === ContainerPhase.Failed
    || container.actual.status === ContainerStatus.Error;
}

/** Lifecycle badge. Only provisioning and deleting. An active row does not spin because the root disk is pending. */
export function containerLifecyclePending(container: Pick<ContainerProgress, 'needsAttention' | 'lifecyclePhase' | 'actual'>): boolean {
  if (containerBlocked(container)) return false;
  return container.lifecyclePhase === ContainerPhase.Provisioning
    || container.lifecyclePhase === ContainerPhase.Deleting;
}

/**
 * Actual-status badge. Failures are excluded first. `creating` is unused on the
 * current GET; provisioning is what a new container reports.
 */
export function containerStatusPending(container: ContainerProgress): boolean {
  if (containerBlocked(container)) return false;
  return container.actual.status === ContainerStatus.Creating
    || container.lifecyclePhase === ContainerPhase.Provisioning
    || container.lifecyclePhase === ContainerPhase.Deleting
    || container.rootSizePendingBytes !== null
    || (container.observedGeneration !== null && container.observedGeneration !== container.generation);
}

export function containerInProgress(container: ContainerProgress): boolean {
  return containerLifecyclePending(container) || containerStatusPending(container);
}

/** Volumes have no root-size field. A null generation on an active row is not in progress. */
export function volumeInProgress(volume: VolumeProgress): boolean {
  if (volume.needsAttention || volume.lifecyclePhase === ResourceLifecyclePhase.Failed) return false;
  return volume.lifecyclePhase === ResourceLifecyclePhase.Provisioning
    || volume.lifecyclePhase === ResourceLifecyclePhase.Deleting
    || (volume.observedGeneration !== null && volume.observedGeneration !== volume.generation);
}

/** A null fingerprint is an empty state, not a phase that polling can finish. */
export function imageInProgress(image: Pick<ImageDto, 'deleting'>): boolean {
  return image.deleting;
}

export function assignmentInProgress(assignment: Pick<
  ImageAssignmentDto,
  'needsAttention' | 'lifecyclePhase' | 'managedFingerprint' | 'observedFingerprint'
>): boolean {
  if (assignment.needsAttention || assignment.lifecyclePhase === ResourceLifecyclePhase.Failed) return false;
  if (
    assignment.lifecyclePhase === ResourceLifecyclePhase.Provisioning
    || assignment.lifecyclePhase === ResourceLifecyclePhase.Deleting
  ) {
    return true;
  }
  return assignment.lifecyclePhase === ResourceLifecyclePhase.Active
    && assignment.managedFingerprint !== assignment.observedFingerprint;
}

export function bindInProgress(state: VolumeBindState): boolean {
  return state === 'attaching' || state === 'detaching';
}

export function intentPending(status: IntentStatus | string): boolean {
  return status === IntentStatus.Pending;
}

export function intentListSettled(items: readonly IntentDto[]): boolean {
  return items.every((item) => item.status !== IntentStatus.Pending)
    && currentOutstandingIntents(items).length === 0;
}

export function preflightPending(status: PreflightStatus | string): boolean {
  return status === PreflightStatus.Running;
}

export function certificateStatePending(state: CertificateState | string): boolean {
  return state === CertificateState.Staged;
}

export function certificateTrustPending(state: CertificateTrustState | string): boolean {
  return state === CertificateTrustState.Pending;
}

export function userDeleting(status: UserStatus | string): boolean {
  return status === UserStatus.Deleting;
}

export function catalogPgPending(state: string | null | undefined): boolean {
  return state === 'ensuring';
}

export function catalogOccupancyPending(occupancy: string): boolean {
  return occupancy === 'ensuring';
}
