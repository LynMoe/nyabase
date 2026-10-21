import { createHash } from 'node:crypto';
import { FailureCode, PreflightStatus, type PreflightReport } from '@nyabase/common';
import type { IncusSchema } from '../incus/index.js';
import type { IntentFailure, IntentRecord } from '../reconcile/intent.repository.js';
import type { ReconcileOutcome } from '../reconcile/managed-reconciler.js';

export interface ServerRow {
  id: string;
  name: string;
  parent_interface: string | null;
  dns_servers: string[] | null;
  server_cert_fingerprint: string | null;
  node_metrics_endpoint: string | null;
  node_metrics_token_ciphertext: string | null;
  status: 'online' | 'unreachable' | 'unknown';
  system_pool_id: string | null;
  preflight_status: 'not_run' | 'running' | 'passed' | 'failed';
  gpu_enabled: boolean;
  revision: string | number | bigint;
}

export interface PreflightOptions {
  readonly probeImageAlias: string;
  readonly probeImageFingerprint: string;
  readonly probePoolName: string;
  readonly probeAddress: string;
  readonly sourceServer?: string;
}

export const TRUST_PROPAGATION_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

export function preflightFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

export function normalized(value: string): string {
  return value.replaceAll('-', '').toLowerCase();
}

export function probeHardwareId(serverId: string): string {
  return createHash('sha256')
    .update(`nyabase-preflight:${normalized(serverId)}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function trustTokenReference(request: Record<string, unknown> | null): string | null {
  const reference = request?.trustTokenRef;
  return typeof reference === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)
    ? reference.toLowerCase()
    : null;
}

export interface ReportChecks {
  api: 'pass' | 'fail';
  parentInterface: 'pass' | 'fail';
  nftables: 'pass' | 'fail';
  ipv4Filtering: 'pass' | 'fail';
  guestCanReachHost: 'pass' | 'fail';
  networkPrerequisites: 'pass' | 'fail';
  storagePool: 'pass' | 'fail';
  simplestreamsImage: 'pass' | 'fail';
  guestAddress: 'pass' | 'fail';
  egress: 'pass' | 'fail';
  nodeMetrics: 'pass' | 'warn' | 'fail';
}

export interface IpPoolNetwork {
  readonly gateway: string;
  readonly cidr: string;
  readonly prefixLength: number;
}

export interface ParentNetworkLookup {
  readonly network?: IncusSchema<'Network'>;
  readonly networkMissing: boolean;
  readonly state?: IncusSchema<'NetworkState'>;
  readonly stateMissing: boolean;
}

export class ServerRevisionChangedError extends Error {
  constructor() {
    super('The server configuration changed during preflight');
    this.name = 'ServerRevisionChangedError';
  }
}

export const MANAGED_PROBE_KEY = 'user.nyabase.preflight';
export const PROBE_SERVER_KEY = 'user.nyabase.server_id';
/** Headroom for Debian probe boot + wget TLS; rc 137 was SIGKILL under pressure. */
export const PREFLIGHT_PROBE_MEMORY = '256MiB';

export function revisionNumber(value: string | number | bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}


export function successReport(checks: ReportChecks, gpu?: Record<string, unknown>): PreflightReport {
  const controlReady = Object.entries(checks).every(([name, value]) => {
    if (name === 'nodeMetrics') return value === 'pass' || value === 'warn';
    return value === 'pass';
  });
  return {
    status: PreflightStatus.Passed,
    controlReady,
    checks,
    failureCode: null,
    checkedAt: new Date().toISOString(),
    ...(gpu ? { gpu } : {}),
  };
}

export function failureReport(
  status: PreflightStatus.Running | PreflightStatus.Failed,
  code: string,
): PreflightReport {
  const failureCode = (Object.values(FailureCode) as string[]).includes(code)
    ? (code as FailureCode)
    : FailureCode.PreflightFailed;
  return {
    status,
    controlReady: false,
    checks: {
      api: 'fail',
      parentInterface: 'fail',
      nftables: 'fail',
      ipv4Filtering: 'fail',
      guestCanReachHost: 'fail',
      networkPrerequisites: 'fail',
      storagePool: 'fail',
      simplestreamsImage: 'fail',
      guestAddress: 'fail',
      egress: 'fail',
      nodeMetrics: 'fail',
    },
    failureCode,
    checkedAt: status === PreflightStatus.Running ? null : new Date().toISOString(),
  };
}

export function staleOutcome(intent: IntentRecord): ReconcileOutcome {
  return {
    outcome: 'succeeded',
    observedRevision: intent.targetRevision,
    stale: true,
  };
}
