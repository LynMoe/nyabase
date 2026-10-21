import { AuditAction } from '@nyabase/common';
import { IncusError, type IncusSchema } from '../incus/index.js';
import type { AuditService } from '../iam/audit.service.js';
import type { IntentFailure, IntentRecord } from '../reconcile/intent.repository.js';

export type Image = IncusSchema<'Image'>;

export interface ImageAssignmentSource {
  readonly alias: string;
  readonly fingerprint: string | null;
  readonly sourceServer: string;
  readonly imageType?: string;
}
export interface AssignmentRow {
  id: string;
  image_id: string;
  server_id: string;
  revision: number;
  observed_fingerprint: string | null;
  managed_fingerprint: string | null;
  lifecycle_phase: 'provisioning' | 'active' | 'deleting' | 'failed';
  alias: string;
  desired_fingerprint: string | null;
  cleanup_generation: number;
}

export interface ImageCleanupRow {
  id: string;
  fingerprint: string | null;
  is_active: boolean;
  deleting: boolean;
  cleanup_generation: number;
}

export function imageFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

export async function auditIncusMutate(
  audit: AuditService,
  intent: IntentRecord,
  detail: {
    readonly method: string;
    readonly path: string;
    readonly instanceName?: string;
  },
): Promise<void> {
  await audit.log(
    intent.requestedBy,
    AuditAction.IncusMutate,
    intent.resourceId,
    intent.resourceType,
    {
      method: detail.method,
      path: detail.path,
      instanceName: detail.instanceName,
      serverId: intent.serverId,
      intentId: intent.id,
    },
  );
}

export class ImagePullNotConfirmedError extends Error {
  readonly code: 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH' | 'IMAGE_NOT_AVAILABLE';
  readonly details: Record<string, unknown>;

  constructor(desired: ImageAssignmentSource) {
    const pinned = desired.fingerprint !== null && desired.fingerprint !== undefined;
    super(
      pinned
        ? 'The pulled image did not have the pinned fingerprint'
        : 'The pulled image alias was not present after the pull',
    );
    this.name = 'ImagePullNotConfirmedError';
    this.code = pinned ? 'IMAGE_ASSIGNMENT_FINGERPRINT_MISMATCH' : 'IMAGE_NOT_AVAILABLE';
    this.details = pinned
      ? { desiredFingerprint: desired.fingerprint }
      : { alias: desired.alias };
  }
}
export function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export function imageFingerprint(image: Image | undefined): string | null {
  return image?.fingerprint ?? null;
}

export function imageHasAlias(image: Image, alias: string): boolean {
  return (image.aliases ?? []).some((item) => item.name === alias);
}

export function sameFingerprint(
  actual: string | null | undefined,
  desired: string | null | undefined,
): boolean {
  return actual !== null
    && actual !== undefined
    && desired !== null
    && desired !== undefined
    && actual.toLowerCase() === desired.toLowerCase();
}

export function selectImageForAssignment(
  images: readonly Image[],
  desired: Pick<ImageAssignmentSource, 'alias' | 'fingerprint'>,
): Image | undefined {
  if (desired.fingerprint !== null && desired.fingerprint !== undefined) {
    return images.find((image) => sameFingerprint(imageFingerprint(image), desired.fingerprint));
  }
  return images.find((image) => imageHasAlias(image, desired.alias));
}

export function canDeleteManagedImage(input: {
  readonly managedFingerprint: string | null;
  readonly actualFingerprint: string | null;
  readonly otherAssignment: boolean;
  readonly pinned: boolean;
  readonly usedBy: boolean;
}): boolean {
  return Boolean(
    input.managedFingerprint
    && sameFingerprint(input.actualFingerprint, input.managedFingerprint)
    && !input.otherAssignment
    && !input.pinned
    && !input.usedBy,
  );
}

