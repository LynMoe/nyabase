import type { ColumnType, Generated } from 'kysely';

type WorkflowTimestamp = ColumnType<Date, Date | string, Date | string>;
type WorkflowGeneratedTimestamp = ColumnType<
  Date,
  Date | string | undefined,
  Date | string
>;
type WorkflowJson = ColumnType<unknown, string | unknown, string | unknown>;
type WorkflowBigInt = ColumnType<string, string | number | bigint, string | number | bigint>;

export interface WorkflowCommandTable {
  id: string;
  kind: string;
  server_id: string;
  resource_type: string;
  resource_id: string;
  requested_by: string | null;
  request_json: WorkflowJson | null;
  admission_class: string;
  created_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowTaskTable {
  id: string;
  command_id: string;
  kind: string;
  server_id: string;
  resource_type: string;
  resource_id: string;
  requested_by: string | null;
  request_json: WorkflowJson | null;
  payload_json: WorkflowJson;
  payload_hash: string;
  admission_class: string;
  status: string;
  failure_stage: string | null;
  generation: WorkflowBigInt;
  agent_result_json: WorkflowJson | null;
  agent_result_hash: string | null;
  result_json: WorkflowJson | null;
  error_json: WorkflowJson | null;
  dispatch_attempt_count: number;
  incomplete_result_count: number;
  finalizer_attempt_count: number;
  retry_window_started_at: WorkflowTimestamp | null;
  next_dispatch_at: WorkflowTimestamp | null;
  started_at: WorkflowTimestamp | null;
  last_sent_at: WorkflowTimestamp | null;
  result_received_at: WorkflowTimestamp | null;
  finalizer_retry_at: WorkflowTimestamp | null;
  completed_at: WorkflowTimestamp | null;
  dispatch_claim_token: string | null;
  dispatch_claimed_by: string | null;
  dispatch_lease_expires_at: WorkflowTimestamp | null;
  finalizer_claim_token: string | null;
  finalizer_claimed_by: string | null;
  finalizer_lease_expires_at: WorkflowTimestamp | null;
  created_at: WorkflowGeneratedTimestamp;
  updated_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowTaskAttemptTable {
  id: Generated<string>;
  task_id: string;
  task_generation: WorkflowBigInt;
  attempt_no: number;
  claim_token: string;
  claimed_by: string;
  state: string;
  claimed_at: WorkflowGeneratedTimestamp;
  sent_at: WorkflowTimestamp | null;
  finished_at: WorkflowTimestamp | null;
  diagnostic_json: WorkflowJson | null;
  agent_session_id: string;
  agent_session_generation: WorkflowBigInt;
  gateway_id: string;
}

export interface WorkflowResourceClaimTable {
  resource_key: string;
  task_id: string;
  task_generation: WorkflowBigInt;
  server_id: string;
  created_at: WorkflowGeneratedTimestamp;
  updated_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowServerExecutionLaneTable {
  server_id: string;
  generation: WorkflowBigInt;
  task_id: string | null;
  task_generation: WorkflowBigInt | null;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: WorkflowTimestamp | null;
  updated_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowReconcileQueueTable {
  id: string;
  dedupe_key: string;
  server_id: string | null;
  resource_type: string;
  resource_id: string;
  reason: string;
  payload_json: WorkflowJson;
  status: string;
  attempt_count: number;
  due_at: WorkflowTimestamp;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: WorkflowTimestamp | null;
  last_error_json: WorkflowJson | null;
  created_at: WorkflowGeneratedTimestamp;
  updated_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowOutboxTable {
  id: Generated<string>;
  topic: string;
  partition_key: string;
  payload_json: WorkflowJson;
  available_at: WorkflowTimestamp;
  claim_token: string | null;
  claimed_by: string | null;
  lease_expires_at: WorkflowTimestamp | null;
  created_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowAgentSessionTable {
  id: string;
  server_id: string;
  generation: WorkflowBigInt;
  session_token_hash: string;
  state: string;
  host_fingerprint: string;
  config_fingerprint: string;
  admitted_at: WorkflowGeneratedTimestamp;
  ready_at: WorkflowTimestamp | null;
  last_seen_at: WorkflowTimestamp;
  retired_at: WorkflowTimestamp | null;
  retire_reason: string | null;
  gateway_id: string;
  console_public_url: string;
  lease_expires_at: WorkflowTimestamp;
}

export interface WorkflowAgentObservationTable {
  id: Generated<string>;
  server_id: string;
  session_id: string;
  sequence: WorkflowBigInt;
  kind: string;
  payload_hash: string;
  payload_json: WorkflowJson | null;
  observed_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowAgentRuntimeProjectionTable {
  server_id: string;
  session_id: string;
  session_generation: WorkflowBigInt;
  gateway_id: string;
  state_sequence: WorkflowBigInt;
  runtime_ready: boolean;
  hello_json: WorkflowJson;
  state_report_json: WorkflowJson | null;
  docker_daemon_json: WorkflowJson | null;
  hello_observed_at: WorkflowTimestamp;
  state_observed_at: WorkflowTimestamp | null;
  updated_at: WorkflowGeneratedTimestamp;
}

export interface WorkflowExecSessionTable {
  id: string;
  server_id: string;
  user_id: string;
  container_id: string;
  runtime_id: string;
  authorization_kind: string;
  agent_session_id: string;
  agent_session_generation: WorkflowBigInt;
  gateway_id: string;
  console_public_url: string;
  state: string;
  claimed_by_gateway_id: string | null;
  created_at: WorkflowGeneratedTimestamp;
  last_activity_at: WorkflowTimestamp;
  expires_at: WorkflowTimestamp;
  closed_at: WorkflowTimestamp | null;
  close_reason: string | null;
}

export interface WorkflowDatabase {
  'workflow.commands': WorkflowCommandTable;
  'workflow.tasks': WorkflowTaskTable;
  'workflow.task_attempts': WorkflowTaskAttemptTable;
  'workflow.resource_claims': WorkflowResourceClaimTable;
  'workflow.server_execution_lanes': WorkflowServerExecutionLaneTable;
  'workflow.reconcile_queue': WorkflowReconcileQueueTable;
  'workflow.outbox': WorkflowOutboxTable;
  'workflow.agent_sessions': WorkflowAgentSessionTable;
  'workflow.agent_observations': WorkflowAgentObservationTable;
  'workflow.agent_runtime_projections': WorkflowAgentRuntimeProjectionTable;
  'workflow.exec_sessions': WorkflowExecSessionTable;
}
