--
-- Persist INSTANCE_BUSY observations for the reconcile attention breaker.
-- In-process Maps cannot trip across worker processes or restarts.
--

CREATE TABLE control.reconcile_busy_strikes (
    resource_type text NOT NULL,
    resource_id uuid NOT NULL,
    observed_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    CONSTRAINT reconcile_busy_strikes_resource_type_check
        CHECK (resource_type = ANY (ARRAY[
            'container',
            'volume',
            'image_assignment',
            'server',
            'certificate_rotation'
        ]))
);

COMMENT ON TABLE control.reconcile_busy_strikes IS
  'INSTANCE_BUSY observations used to trip needs_attention after five strikes in five minutes';

CREATE INDEX reconcile_busy_strikes_resource_observed_idx
    ON control.reconcile_busy_strikes (resource_type, resource_id, observed_at DESC);
