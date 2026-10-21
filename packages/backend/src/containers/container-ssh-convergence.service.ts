import { Inject, Injectable } from '@nestjs/common';
import { IntentKind, IntentResourceType } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { retryPgTransaction } from '../platform/persistence-pg/transaction.js';
import { executeWithPostCommit } from '../platform/post-commit.js';
import { IntentRepository } from '../reconcile/intent.repository.js';

type SshSyncOperation = 'sync_user_ssh_keys' | 'repair_ssh';

@Injectable()
export class ContainerSshConvergenceService {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly intents: IntentRepository,
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
   * SSH key content is not part of the Incus instance document revision gate.
   * Wake alone only drains existing pending intents — it never rewrites authorized_keys.
   * Bump revision + create container.update so reconcileSshFile runs with fresh keys.
   */
  private async enqueueContainerSshSync(
    containerId: string,
    operation: SshSyncOperation,
  ): Promise<boolean> {
    const result = await retryPgTransaction(async () => {
      return executeWithPostCommit(
        this.database.transaction().setIsolationLevel('serializable'),
        async (transaction) => {
          const container = await transaction.selectFrom('control.containers')
            .select(['id', 'server_id', 'revision', 'lifecycle_phase'])
            .where('id', '=', containerId)
            .forUpdate()
            .executeTakeFirst();
          if (!container || container.lifecycle_phase !== 'active') {
            return null;
          }
          const revision = Number(container.revision) + 1;
          const updated = await transaction.updateTable('control.containers')
            .set({ revision })
            .where('id', '=', containerId)
            .where('revision', '=', container.revision)
            .returning(['id', 'server_id', 'revision'])
            .executeTakeFirst();
          if (!updated) {
            throw new Error('CONTAINER_REVISION_CONFLICT');
          }
          const intent = await this.intents.createPending({
            kind: IntentKind.ContainerUpdate,
            resourceType: IntentResourceType.Container,
            resourceId: containerId,
            serverId: updated.server_id,
            targetRevision: updated.revision,
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
    return true;
  }
}
