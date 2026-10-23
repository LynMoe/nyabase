import { sql, type RawBuilder } from 'kysely';
import { runsDespiteAttentionSql } from '../reconcile/intent-model.js';

/** Wait after the container's last intent before a stuck enforcement is queued again. */
export const DETACH_REDRIVE_BACKOFF_MS = 15 * 60_000;
/** The waits double with each enforcement intent already queued, up to this. */
export const DETACH_REDRIVE_MAX_BACKOFF_MS = 4 * 60 * 60_000;

/**
 * Whether an access-lapse enforcement on a container (unplugging a revoked
 * volume, stopping a container whose server grant lapsed) that did not take
 * effect is due to be queued again: no intent of the container is pending that
 * the worker will run, and the container's last intent settled at least the
 * backoff ago. An intent pending on a container that needs attention counts
 * only when it runs despite the attention (`runsDespiteAttention`, the
 * worker's own rule): any other one (an SSH key sync, say) waits for an
 * operator and would otherwise hold the enforcement off indefinitely. The
 * backoff starts at `DETACH_REDRIVE_BACKOFF_MS` and doubles with every
 * `enforcement` intent the container already had (the predicate is applied to
 * `enforcement_intent`), up to `DETACH_REDRIVE_MAX_BACKOFF_MS`: a transient
 * failure is enforced again soon, while a container whose intents keep failing
 * (it needs an operator) gets a handful of new intents a day instead of one
 * per access-lapse pass.
 */
export function containerRedriveDue(
  containerId: RawBuilder<unknown>,
  enforcement: RawBuilder<boolean>,
): RawBuilder<boolean> {
  return sql<boolean>`(
    NOT EXISTS (
      SELECT 1 FROM control.intents AS pending_intent
      WHERE pending_intent.resource_type = 'container'
        AND pending_intent.resource_id = ${containerId}
        AND pending_intent.status = 'pending'
        AND (
          ${runsDespiteAttentionSql(sql.ref('pending_intent.request_json'))}
          OR NOT EXISTS (
            SELECT 1 FROM control.containers AS parked
            WHERE parked.id = ${containerId} AND parked.needs_attention
          )
        )
    )
    AND coalesce((
      SELECT max(settled_intent.settled_at) FROM control.intents AS settled_intent
      WHERE settled_intent.resource_type = 'container'
        AND settled_intent.resource_id = ${containerId}
    ), '-infinity'::timestamptz) + make_interval(secs => least(
      ${DETACH_REDRIVE_BACKOFF_MS / 1000}::double precision * power(2::double precision, least(greatest((
        SELECT count(*) FROM control.intents AS enforcement_intent
        WHERE enforcement_intent.resource_type = 'container'
          AND enforcement_intent.resource_id = ${containerId}
          AND ${enforcement}
      ) - 1, 0), 16)::double precision),
      ${DETACH_REDRIVE_MAX_BACKOFF_MS / 1000}::double precision
    )) <= clock_timestamp()
  )`;
}

/**
 * Whether a `detaching` attachment is due to be detached again
 * (`containerRedriveDue`, counting the attachment's detach intents). Shared by
 * the access-lapse scan (`exposed`) and `forceDetach`, so both agree on when a
 * re-drive is due.
 */
export function detachRedriveDue(
  attachmentId: RawBuilder<unknown>,
  containerId: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return containerRedriveDue(containerId, sql<boolean>`(
    enforcement_intent.request_json ->> 'operation' = 'detach_volume'
    AND enforcement_intent.request_json ->> 'attachmentId' = ${attachmentId}::text
  )`);
}
