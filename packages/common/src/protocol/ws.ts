/**
 * Strongly-typed WS message envelopes for the Agent ↔ Backend protocol.
 *
 * All payload schemas live in `./agent-messages.ts`; this module only adds
 * the discriminated `Envelope<kind, payload>` union on top of them.
 */

import { ContainerStatus } from '../enums.js';
import type {
  // Agent → Backend
  HelloPayload,
  HeartbeatPayload,
  StateReportPayload,
  MetricsBatchPayload,
  CommandAckPayload,
  AgentCommandEnvelope,
  OperationProgressPayload,
  ContainerEventPayload,
  LogChunkPayload,
  DataDirReportPayload,
  PullProgressPayload,
  RemoteFsMountStatus,
  DockerDaemonStatus,
  // Backend → Agent
  ExecStreamPayload,
  ExecResizePayload,
  ExecInputPayload,
  ExecClosePayload,
  ReconcilePayload,
  FetchContainerStatsPayload,
  CheckDiskPayload,
  SelfCheckPayload,
  ReconcileDockerDaemonPayload,
} from './agent-messages.js';

// Re-export payload types so consumers can keep importing them from `ws.ts`.
export type {
  DiskInfo,
  GpuInfo,
  DataDirMount,
  ContainerSpec,
  ContainerSshServerStatus,
  ContainerSshServerState,
  ContainerStatsSummary,
  ContainerSnapshot,
  XfsProjectUsage,
  LocalImageInfo,
  DataDirEntry,
  HelloPayload,
  HeartbeatPayload,
  StateReportPayload,
  MetricPoint,
  MetricsBatchPayload,
  CommandAckPayload,
  AgentCommandEnvelope,
  OperationProgressPayload,
  ContainerEventPayload,
  LogChunkPayload,
  DataDirReportPayload,
  PullProgressPayload,
  NfsParams,
  CephFsParams,
  RemoteFsParams,
  RemoteFsMountSpec,
  RemoteFsMountStatus,
  ContainerMountSpec,
  DataDiskSpec,
  DockerDaemonStatus,
  CreateContainerPayload,
  StartContainerPayload,
  StopContainerPayload,
  RestartContainerPayload,
  ContainerSetPowerPayload,
  DeleteContainerPayload,
  UpdateUserQuotaPayload,
  PullImagePayload,
  ExecStreamPayload,
  ExecResizePayload,
  ExecInputPayload,
  ExecClosePayload,
  CreateDataDirPayload,
  DeleteDataDirPayload,
  ReconcilePayload,
  FetchContainerStatsPayload,
  CheckDiskPayload,
  ApplyDataDiskPayload,
  RemoveDataDiskPayload,
  ApplyRemoteFsMountPayload,
  RemoveRemoteFsMountPayload,
  ReconcileContainerMountsPayload,
  ApplyContainerMountPayload,
  RemoveContainerMountPayload,
  SelfCheckPayload,
  SelfCheckItem,
  SelfCheckResult,
  ReconcileDockerDaemonPayload,
  ReconcileContainerSshPayload,
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

export interface CheckDiskResult {
  exists: boolean;
  fsType: string;
  isXfs: boolean;
}

export interface RegisterDiskResult {
  diskId: string;
}

// ---------------------------------------------------------------------------
// Message kind union types
// ---------------------------------------------------------------------------

export type AgentToBackendMessage =
  | Envelope<'hello', HelloPayload>
  | Envelope<'heartbeat', HeartbeatPayload>
  | Envelope<'stateReport', StateReportPayload>
  | Envelope<'metricsBatch', MetricsBatchPayload>
  | Envelope<'commandAck', CommandAckPayload>
  | Envelope<'operationProgress', OperationProgressPayload>
  | Envelope<'containerEvent', ContainerEventPayload>
  | Envelope<'logChunk', LogChunkPayload>
  | Envelope<'dataDirReport', DataDirReportPayload>
  | Envelope<'pullProgress', PullProgressPayload>
  | Envelope<'remoteFsMountStatus', RemoteFsMountStatus>
  | Envelope<'dockerDaemonStatus', DockerDaemonStatus>;

export type BackendToAgentMessage =
  | Envelope<'agentCommand', AgentCommandEnvelope>
  | Envelope<'execStream', ExecStreamPayload>
  | Envelope<'execResize', ExecResizePayload>
  | Envelope<'execInput', ExecInputPayload>
  | Envelope<'execClose', ExecClosePayload>
  | Envelope<'reconcile', ReconcilePayload>
  | Envelope<'fetchContainerStats', FetchContainerStatsPayload>
  | Envelope<'checkDisk', CheckDiskPayload>
  | Envelope<'selfCheck', SelfCheckPayload>
  | Envelope<'reconcileDockerDaemon', ReconcileDockerDaemonPayload>;

// Re-exported for legacy consumers that imported ContainerStatus through ws.ts.
export { ContainerStatus };
