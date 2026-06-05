/** Docker labels that remain authoritative identity/discovery hints. */
export const LABEL = {
  MANAGED: 'nyabase.managed',
  CONTAINER_ID: 'nyabase.container_id',
  SERVER_ID: 'nyabase.server_id',
  SPEC_GENERATION: 'nyabase.spec_generation',
} as const;

export const NYABASE_NETWORK = 'nyabase_net';

/** Current desired-spec generation written to DB/outbox; labels carry only this hint. */
export const SPEC_VERSION = '3';

