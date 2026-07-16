/**
 * Strongly-typed WS message envelopes for the Agent ↔ Backend protocol.
 *
 * All payload schemas live in `./agent-messages.ts`; this module only adds
 * the discriminated `Envelope<kind, payload>` union on top of them.
 */

import type {
  // Agent → Backend
  HelloPayload,
  HeartbeatPayload,
  InventoryFaultPayload,
  StateReportPayload,
  MetricsBatchPayload,
  CommandAckPayload,
  TaskExecutePayload,
  TaskResultPayload,
  TaskAcceptedPayload,
  LogChunkPayload,
  DockerDaemonStatus,
  // Backend → Agent
  ExecStreamPayload,
  ExecResizePayload,
  ExecInputPayload,
  ExecClosePayload,
  ReconcilePayload,
  AdmissionReadyPayload,
  InspectContainerPayload,
  AgentBootstrapPayload,
  SelfCheckPayload,
} from './agent-messages.js';

// Re-export payload types so consumers can keep importing them from `ws.ts`.
export type {
  DiskInfo,
  GpuInfo,
  ContainerRuntimeObservation,
  ContainerSshServerStatus,
  ContainerSshServerState,
  ContainerStatsSummary,
  ContainerSnapshot,
  XfsProjectUsage,
  LocalImageInfo,
  DataDirEntry,
  HelloPayload,
  HeartbeatPayload,
  InventoryFaultPayload,
  StateReportPayload,
  MetricPoint,
  MetricsBatchPayload,
  CommandAckPayload,
  TaskExecutePayload,
  TaskError,
  TaskResultPayload,
  TaskAcceptedPayload,
  LogChunkPayload,
  NfsParams,
  CephFsParams,
  RemoteFsParams,
  RemoteFsMountSpec,
  RemoteFsMountStatus,
  ContainerMountSpec,
  DataDiskSpec,
  DataDirName,
  DockerDaemonStatus,
  ExecStreamPayload,
  ExecResizePayload,
  ExecInputPayload,
  ExecClosePayload,
  ReconcilePayload,
  AdmissionReadyPayload,
  InspectContainerPayload,
  InspectContainerResult,
  AgentBootstrapPayload,
  AgentBootstrapResult,
  SelfCheckPayload,
  SelfCheckItem,
  SelfCheckResult,
  ContainerSshTaskSpec,
  ContainerCreateTaskPayload,
  ContainerStartTaskPayload,
  ContainerStopTaskPayload,
  ContainerRestartTaskPayload,
  ContainerDeleteTaskPayload,
  ContainerRuntimeAbsentTaskPayload,
  ContainerSshEnsureTaskPayload,
  DataDirEnsureTaskPayload,
  DataDirAbsentTaskPayload,
  RemoteFsEnsureTaskPayload,
  RemoteFsAbsentTaskPayload,
  QuotaEnsureTaskPayload,
  ImageEnsurePresentTaskPayload,
  ImageEnsureAbsentTaskPayload,
  AgentTaskPayloadByKind,
} from './agent-messages.js';

// ---------------------------------------------------------------------------
// Generic envelope (cannot be derived from zEnvelope because of generics)
// ---------------------------------------------------------------------------

/** Generic envelope for all WS messages */
export interface Envelope<K extends string = string, P = unknown> {
  /** RPC correlation id; absent for one-way events */
  id?: string;
  /** Unix epoch ms */
  ts: number;
  kind: K;
  payload: P;
}

// ---------------------------------------------------------------------------
// Auxiliary types not represented as Zod schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Message kind union types
// ---------------------------------------------------------------------------

export type AgentToBackendMessage =
  | Envelope<'hello', HelloPayload>
  | Envelope<'heartbeat', HeartbeatPayload>
  | Envelope<'inventoryFault', InventoryFaultPayload>
  | Envelope<'stateReport', StateReportPayload>
  | Envelope<'metricsBatch', MetricsBatchPayload>
  | Envelope<'commandAck', CommandAckPayload>
  | Envelope<'task.result.v1', TaskResultPayload>
  | Envelope<'logChunk', LogChunkPayload>
  | Envelope<'dockerDaemonStatus', DockerDaemonStatus>;

export type BackendToAgentMessage =
  | Envelope<'admission.ready.v1', AdmissionReadyPayload>
  | Envelope<'task.execute.v1', TaskExecutePayload>
  | Envelope<'task.accepted.v1', TaskAcceptedPayload>
  | Envelope<'execStream', ExecStreamPayload>
  | Envelope<'execResize', ExecResizePayload>
  | Envelope<'execInput', ExecInputPayload>
  | Envelope<'execClose', ExecClosePayload>
  | Envelope<'reconcile', ReconcilePayload>
  | Envelope<'inspectContainer', InspectContainerPayload>
  | Envelope<'agent.bootstrap.v1', AgentBootstrapPayload>
  | Envelope<'selfCheck', SelfCheckPayload>;

export const DIRECT_WS_COMMAND_KINDS = [
  'execStream',
  'execResize',
  'execInput',
  'execClose',
  'reconcile',
  'inspectContainer',
  'agent.bootstrap.v1',
  'selfCheck',
] as const;

export type DirectWsCommandKind = (typeof DIRECT_WS_COMMAND_KINDS)[number];

const directWsCommandKindSet = new Set<string>(DIRECT_WS_COMMAND_KINDS);

export function isDirectWsCommandKind(kind: string): kind is DirectWsCommandKind {
  return directWsCommandKindSet.has(kind);
}

export const DIRECT_RPC_KINDS = [
  'execStream',
  'inspectContainer',
  'agent.bootstrap.v1',
  'selfCheck',
] as const;

export type DirectRpcKind = (typeof DIRECT_RPC_KINDS)[number];
const directRpcKindSet = new Set<string>(DIRECT_RPC_KINDS);

export function isDirectRpcKind(kind: string): kind is DirectRpcKind {
  return directRpcKindSet.has(kind);
}

export const PUBLIC_DIRECT_RPC_KINDS = [
  'execStream',
  'inspectContainer',
  'selfCheck',
] as const;

export type PublicDirectRpcKind = (typeof PUBLIC_DIRECT_RPC_KINDS)[number];
const publicDirectRpcKindSet = new Set<string>(PUBLIC_DIRECT_RPC_KINDS);

export function isPublicDirectRpcKind(kind: string): kind is PublicDirectRpcKind {
  return publicDirectRpcKindSet.has(kind);
}

export const AGENT_NOTIFY_KINDS = [
  'execResize',
  'execInput',
  'execClose',
  'reconcile',
] as const;

export type AgentNotifyKind = (typeof AGENT_NOTIFY_KINDS)[number];
const agentNotifyKindSet = new Set<string>(AGENT_NOTIFY_KINDS);

export function isAgentNotifyKind(kind: string): kind is AgentNotifyKind {
  return agentNotifyKindSet.has(kind);
}
