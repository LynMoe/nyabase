import { ConflictException } from '@nestjs/common';
import { CONTAINER_DELETE_PROXY_DRAIN_MS, MAX_HTTP_PROXY_ROUTES } from '@nyabase/common';
import { sql, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import {
  HOSTNAME_RESERVATION_LOCK,
  isUniqueConstraintViolation,
  lockHttpProxy,
  type BindingRow,
} from './http-proxy-support.js';

export const MAX_HTTP_HOSTNAME_RESERVATIONS = MAX_HTTP_PROXY_ROUTES * 2;
const HOSTNAME_RESERVATION_GC_BATCH = 256;

/**
 * Claim a hostname for a binding. A released hostname stays reserved while
 * the proxy drains, so it cannot be reused before old routes expire.
 */
export async function reserveHostname(
  transaction: Transaction<NyabaseDatabase>,
  hostname: string,
  ownerId: string,
  bindingId: string,
): Promise<void> {
  await lockHttpProxy(transaction, HOSTNAME_RESERVATION_LOCK);
  const expired = await transaction
    .selectFrom('interaction.http_hostname_reservations')
    .select('hostname')
    .where('state', '=', 'releasing')
    .where('reusable_at', '<=', sql<Date>`clock_timestamp()`)
    .orderBy('reusable_at')
    .orderBy('hostname')
    .limit(HOSTNAME_RESERVATION_GC_BATCH)
    .forUpdate()
    .skipLocked()
    .execute();
  if (expired.length > 0) {
    await transaction
      .deleteFrom('interaction.http_hostname_reservations')
      .where('hostname', 'in', expired.map((row) => row.hostname))
      .where('state', '=', 'releasing')
      .where('reusable_at', '<=', sql<Date>`clock_timestamp()`)
      .execute();
  }
  const [existingBinding, reservation] = await Promise.all([
    transaction
      .selectFrom('interaction.http_proxy_bindings')
      .select('id')
      .where('hostname', '=', hostname)
      .executeTakeFirst(),
    transaction
      .selectFrom('interaction.http_hostname_reservations')
      .select('hostname')
      .where('hostname', '=', hostname)
      .executeTakeFirst(),
  ]);
  if (existingBinding || reservation) {
    throw new ConflictException('Hostname is already occupied or draining');
  }
  const count = await transaction
    .selectFrom('interaction.http_hostname_reservations')
    .select((expression) => expression.fn.countAll<string>().as('count'))
    .executeTakeFirstOrThrow();
  if (Number(count.count) >= MAX_HTTP_HOSTNAME_RESERVATIONS) {
    throw new ConflictException({
      code: 'HTTP_HOSTNAME_RESERVATION_CAPACITY_REACHED',
      message: `At most ${MAX_HTTP_HOSTNAME_RESERVATIONS} active or draining hostnames are supported`,
    });
  }
  try {
    await transaction
      .insertInto('interaction.http_hostname_reservations')
      .values({
        hostname,
        owner_id: ownerId,
        binding_id: bindingId,
        state: 'active',
        reusable_at: null,
        release_generation: 0,
      })
      .execute();
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      throw new ConflictException('Hostname is already occupied or draining');
    }
    throw error;
  }
}

/** Start draining a binding's hostname reservation. */
export async function releaseHostname(
  transaction: Transaction<NyabaseDatabase>,
  binding: BindingRow,
): Promise<void> {
  await lockHttpProxy(transaction, HOSTNAME_RESERVATION_LOCK);
  const result = await transaction
    .updateTable('interaction.http_hostname_reservations')
    .set({
      state: 'releasing',
      binding_id: null,
      reusable_at: sql<Date>`
        clock_timestamp()
          + (${CONTAINER_DELETE_PROXY_DRAIN_MS} * interval '1 millisecond')
      `,
      release_generation: sql`release_generation + 1`,
    })
    .where('hostname', '=', binding.hostname)
    .where('owner_id', '=', binding.owner_id)
    .where('binding_id', '=', binding.id)
    .where('state', '=', 'active')
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) {
    throw new ConflictException(
      'Hostname reservation identity is missing or inconsistent',
    );
  }
}
