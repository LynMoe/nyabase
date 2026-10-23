import { sql, type RawBuilder } from 'kysely';

/** Wait after the container's last intent before a stuck detach is queued again. */
export const DETACH_REDRIVE_BACKOFF_MS = 15 * 60_000;
/** The waits double with each detach the attachment already had, up to this. */
export const DETACH_REDRIVE_MAX_BACKOFF_MS = 4 * 60 * 60_000;

/**
 * Whether a `detaching` attachment is due to be detached again: no intent of
 * its container is pending (none is left to unplug the device; the reconciler
 * deletes the row once the device is gone), and the container's last intent
 * settled at least the backoff ago. The backoff starts at
 * `DETACH_REDRIVE_BACKOFF_MS` and doubles with every detach intent the
 * attachment already had, up to `DETACH_REDRIVE_MAX_BACKOFF_MS`: a transient
 * failure is enforced again soon, while a container whose intents keep
 * failing (it needs an operator) gets a handful of new intents a day instead
 * of one per access-lapse pass. Shared by the access-lapse scan (`exposed`)
 * and `forceDetach`, so both agree on when a re-drive is due.
 */
export function detachRedriveDue(
  attachmentId: RawBuilder<unknown>,
  containerId: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`(
    NOT EXISTS (
      SELECT 1 FROM control.intents AS pending_intent
      WHERE pending_intent.resource_type = 'container'
        AND pending_intent.resource_id = ${containerId}
        AND pending_intent.status = 'pending'
    )
    AND coalesce((
      SELECT max(settled_intent.settled_at) FROM control.intents AS settled_intent
      WHERE settled_intent.resource_type = 'container'
        AND settled_intent.resource_id = ${containerId}
    ), '-infinity'::timestamptz) + make_interval(secs => least(
      ${DETACH_REDRIVE_BACKOFF_MS / 1000}::double precision * power(2::double precision, least(greatest((
        SELECT count(*) FROM control.intents AS detach_intent
        WHERE detach_intent.resource_type = 'container'
          AND detach_intent.resource_id = ${containerId}
          AND detach_intent.request_json ->> 'operation' = 'detach_volume'
          AND detach_intent.request_json ->> 'attachmentId' = ${attachmentId}::text
      ) - 1, 0), 16)::double precision),
      ${DETACH_REDRIVE_MAX_BACKOFF_MS / 1000}::double precision
    )) <= clock_timestamp()
  )`;
}
