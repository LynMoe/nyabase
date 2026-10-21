import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from './database.types.js';

export type AdvisoryLockExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/** Namespace (first key) shared by the infra.* admission and per-server advisory locks. */
export const INFRASTRUCTURE_ADVISORY_NAMESPACE = 1_856_214_885;
const SERVER_ONBOARDING_ADVISORY_KEY = 5;
const IMAGE_CAPACITY_ADVISORY_KEY = 6;

/** Transaction-scoped lock serializing server admission and removal. */
export async function lockServerOnboarding(executor: AdvisoryLockExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${SERVER_ONBOARDING_ADVISORY_KEY}
  )`.execute(executor);
}

/** Transaction-scoped lock serializing image admission against the platform image cap. */
export async function lockImageCapacity(executor: AdvisoryLockExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${IMAGE_CAPACITY_ADVISORY_KEY}
  )`.execute(executor);
}
