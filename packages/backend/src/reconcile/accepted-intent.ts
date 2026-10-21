import type { IntentAcceptedDto, IntentStatus } from '@nyabase/common';
import type { IntentRecord } from './intent.repository.js';

export function acceptedIntent(intent: IntentRecord): IntentAcceptedDto {
  return {
    intentId: intent.id,
    resourceType: intent.resourceType as IntentAcceptedDto['resourceType'],
    resourceId: intent.resourceId,
    serverId: intent.serverId,
    targetGeneration: intent.targetGeneration,
    status: 'pending' as IntentStatus.Pending,
    createdAt: intent.createdAt,
  };
}
