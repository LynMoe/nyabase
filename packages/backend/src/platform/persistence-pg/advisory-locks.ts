import type { Kysely, Transaction } from 'kysely';
import { sql } from 'kysely';
import type { NyabaseDatabase } from './database.types.js';

export type AdvisoryLockExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

/** Namespace (first key) shared by the infra.* admission and per-server advisory locks. */
export const INFRASTRUCTURE_ADVISORY_NAMESPACE = 1_856_214_885;
const SERVER_ONBOARDING_ADVISORY_KEY = 5;
const IMAGE_CAPACITY_ADVISORY_KEY = 6;
const IP_POOL_TOPOLOGY_ADVISORY_KEY = 7;
const FIREWALL_POLICY_ADVISORY_KEY = 8;
const SSH_PROXY_LINES_ADVISORY_KEY = 9;

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

/**
 * Transaction-scoped lock serializing IP pool CIDR changes. The overlap check
 * reads every pool, so two overlapping pools (a /16 and a /24 inside it) have
 * different network keys and only this lock keeps them from both committing.
 */
export async function lockIpPoolTopology(executor: AdvisoryLockExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${IP_POOL_TOPOLOGY_ADVISORY_KEY}
  )`.execute(executor);
}

/**
 * Transaction-scoped lock serializing firewall rule writes: the per-server
 * limits sum over every rule associated with a server, so two writes adding
 * rules to the same server could each pass the check without it.
 */
export async function lockFirewallPolicy(executor: AdvisoryLockExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${FIREWALL_POLICY_ADVISORY_KEY}
  )`.execute(executor);
}

/** Transaction-scoped lock serializing SSH proxy line writes (their count and order span every line). */
export async function lockSshProxyLines(executor: AdvisoryLockExecutor): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${INFRASTRUCTURE_ADVISORY_NAMESPACE},
    ${SSH_PROXY_LINES_ADVISORY_KEY}
  )`.execute(executor);
}

/** Namespace for per-server CPU set allocation; the second key is hashtext(server id). */
export const CPU_SET_ADVISORY_NAMESPACE = 1_856_214_886;

/** Transaction-scoped lock serializing CPU set allocation on one server. */
export async function lockServerCpuSets(executor: AdvisoryLockExecutor, serverId: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${CPU_SET_ADVISORY_NAMESPACE},
    hashtext(${serverId}::text)
  )`.execute(executor);
}

/** Namespace for per-(owner, server) quota admission; the second key hashes both ids. */
export const OWNER_SERVER_QUOTA_ADVISORY_NAMESPACE = 1_856_214_887;

/** Transaction-scoped lock serializing a user's quota checks on one server. */
export async function lockOwnerServerQuota(
  executor: AdvisoryLockExecutor,
  ownerId: string,
  serverId: string,
): Promise<void> {
  await sql`select pg_advisory_xact_lock(
    ${OWNER_SERVER_QUOTA_ADVISORY_NAMESPACE},
    hashtext(${ownerId}::text || ':' || ${serverId}::text)
  )`.execute(executor);
}
