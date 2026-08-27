import { Inject, Injectable } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { retryPgTransaction } from '../persistence-pg/transaction.js';
import { IntentRepository } from '../runtime/intent.repository.js';
import { ReconcileWakeService } from '../runtime/reconcile-wake.service.js';

type SshSyncOperation = 'sync_user_ssh_keys' | 'repair_ssh';

@Injectable()
export class ContainerSshConvergenceService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
    private readonly wake: ReconcileWakeService,
  ) {}

  async reconcileUser(userId: string): Promise<void> {
    const containers = await this.database.selectFrom('control.containers')
      .select(['id'])
      .where('owner_id', '=', userId)
      .where('lifecycle_phase', '=', 'active')
      .execute();
    for (const container of containers) {
      await this.enqueueContainerSshSync(container.id, 'sync_user_ssh_keys');
    }
  }

  async repairContainer(containerId: string): Promise<{ woken: boolean }> {
    const woken = await this.enqueueContainerSshSync(containerId, 'repair_ssh');
    return { woken };
  }

  /**
   * SSH key content is not part of the Incus instance document generation gate.
   * Wake alone only drains existing pending intents — it never rewrites authorized_keys.
   * Bump generation + create container.update so reconcileSshFile runs with fresh keys.
   */
  private async enqueueContainerSshSync(
    containerId: string,
    operation: SshSyncOperation,
  ): Promise<boolean> {
    const result = await retryPgTransaction(async () => {
      return this.database
        .transaction()
        .setIsolationLevel('serializable')
        .execute(async (transaction) => {
          const container = await transaction.selectFrom('control.containers')
            .select(['id', 'server_id', 'generation', 'lifecycle_phase'])
            .where('id', '=', containerId)
            .forUpdate()
            .executeTakeFirst();
          if (!container || container.lifecycle_phase !== 'active') {
            return null;
          }
          const generation = Number(container.generation) + 1;
          const updated = await transaction.updateTable('control.containers')
            .set({ generation })
            .where('id', '=', containerId)
            .where('generation', '=', container.generation)
            .returning(['id', 'server_id', 'generation'])
            .executeTakeFirst();
          if (!updated) {
            throw new Error('CONTAINER_GENERATION_CONFLICT');
          }
          const intent = await this.intents.createPending({
            kind: IntentKind.ContainerUpdate,
            resourceType: IntentResourceType.Container,
            resourceId: containerId,
            serverId: updated.server_id,
            targetGeneration: updated.generation,
            request: { operation },
          }, transaction);
          return {
            containerId,
            serverId: updated.server_id,
            intentId: intent.id,
          };
        });
    }, { maxAttempts: 5, retryBaseDelayMs: 5 });

    if (!result) {
      return false;
    }
    this.wake.wake({
      resourceType: IntentResourceType.Container,
      resourceId: result.containerId,
      serverId: result.serverId,
      reason: 'intent',
    });
    return true;
  }
}
