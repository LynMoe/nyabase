import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  CertificateState,
  CertificateTrustState,
  FailureCode,
  PreflightStatus,
  type NodeMetricSample,
  type PreflightReport,
} from '@nyabase/common';
import { Kysely, sql, type Transaction } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { lockServerOnboarding } from '../infrastructure/infrastructure.repository.js';
import {
  IncusError,
  deriveInstanceHwaddr,
  isOperationWaitNotFound,
  normalizeCertificateFingerprint,
  requestAndWait,
  readAfterTimeout,
  type IncusClientPort,
  type IncusResponse,
  type IncusSchema,
} from '../incus/index.js';
import { applyGuestNetwork, parseCidrPrefix } from './guest-network.adapter.js';
import { RedisEphemeralStateUnavailableError } from './redis-disposable.adapter.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import type { IntentFailure, IntentRecord } from './intent.repository.js';
import type {
  ManagedReconciler,
  ReconcileOutcome,
  ReconcileRunContext,
} from './reconcile-worker.service.js';

export const NODE_METRICS_PULL = Symbol('NODE_METRICS_PULL');
export const PREFLIGHT_CHECKS = Symbol('PREFLIGHT_CHECKS');
export const SERVER_TRUST_TOKEN = Symbol('SERVER_TRUST_TOKEN');

export interface NodeMetricsPullPort {
  pull(
    serverId: string,
    endpoint: string,
    tokenCiphertext: string | null,
    signal?: AbortSignal,
  ): Promise<{
    readonly status: 'online' | 'unreachable' | 'unknown';
    readonly report?: Record<string, unknown> & {
      readonly samples?: readonly NodeMetricSample[];
    };
  }>;
}

export interface PreflightChecksPort {
  checkNetworkPrerequisites(
    serverId: string,
    evidence?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  checkGpuToolkit(
    serverId: string,
    resources: IncusSchema<'Resources'>,
    evidence?: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<Record<string, unknown>>;
  checkEgress(
    serverId: string,
    client: IncusClientPort,
    probeName: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
}

export interface ServerTrustTokenPort {
  storeTrustToken(serverId: string, token: string): Promise<string>;
  claimTrustToken(serverId: string, reference: string, claimId: string): Promise<string | null>;
  consumeClaimedTrustToken(serverId: string, reference: string, claimId: string): Promise<boolean>;
  releaseClaimedTrustToken(serverId: string, reference: string, claimId: string): Promise<boolean>;
}

interface ServerRow {
  id: string;
  name: string;
  parent_interface: string | null;
  server_cert_fingerprint: string | null;
  node_metrics_endpoint: string | null;
  node_metrics_token_ciphertext: string | null;
  status: 'online' | 'unreachable' | 'unknown';
  system_pool_id: string | null;
  preflight_status: 'not_run' | 'running' | 'passed' | 'failed';
  revision: string | number | bigint;
}

interface ActiveCertificateTrust {
  certificateId: string;
  state: CertificateTrustState | null;
}

type ServerPreflightExecutor = Kysely<NyabaseDatabase> | Transaction<NyabaseDatabase>;

interface PreflightOptions {
  readonly probeImageAlias: string;
  readonly probeImageFingerprint: string;
  readonly probePoolName: string;
  readonly probeAddress: string;
  readonly sourceServer?: string;
}

const TRUST_PROPAGATION_RETRY_DELAYS_MS = [100, 250, 500, 1_000] as const;

function preflightFailure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): IntentFailure {
  return { code, message, details };
}

function normalized(value: string): string {
  return value.replaceAll('-', '').toLowerCase();
}

function probeHardwareId(serverId: string): string {
  return createHash('sha256')
    .update(`nyabase-preflight:${normalized(serverId)}`, 'utf8')
    .digest('hex')
    .slice(0, 32);
}

function isTrustedCertificateState(
  state: CertificateTrustState | null,
): state is CertificateTrustState.Trusted | CertificateTrustState.Verified {
  return state === CertificateTrustState.Trusted || state === CertificateTrustState.Verified;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function trustTokenReference(request: Record<string, unknown> | null): string | null {
  const reference = request?.trustTokenRef;
  return typeof reference === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reference)
    ? reference.toLowerCase()
    : null;
}

interface ReportChecks {
  api: 'pass' | 'fail';
  parentInterface: 'pass' | 'fail';
  gpuRuntime: 'pass' | 'fail' | 'not_applicable';
  forwarding: 'pass' | 'fail';
  nftables: 'pass' | 'fail';
  rpFilter: 'pass' | 'fail';
  networkPrerequisites: 'pass' | 'fail';
  storagePool: 'pass' | 'fail';
  simplestreamsImage: 'pass' | 'fail';
  routedAddress: 'pass' | 'fail';
  egress: 'pass' | 'fail';
  nodeMetrics: 'pass' | 'warn' | 'fail';
}

class ServerRevisionChangedError extends Error {
  constructor() {
    super('The server configuration changed during preflight');
    this.name = 'ServerRevisionChangedError';
  }
}

@Injectable()
export class ServerPreflightReconciler implements ManagedReconciler {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    @Inject(NODE_METRICS_PULL) private readonly nodeMetrics: NodeMetricsPullPort,
    @Inject(PREFLIGHT_CHECKS) private readonly checks: PreflightChecksPort,
    @Inject(SERVER_TRUST_TOKEN) private readonly trustTokens: ServerTrustTokenPort,
    private readonly config: NyabaseConfigService,
  ) {}

  supports(intent: IntentRecord): boolean {
    return intent.resourceType === 'server';
  }

  async reconcile(context: ReconcileRunContext): Promise<ReconcileOutcome> {
    if (!context.client || !context.intent.serverId) {
      throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'missing_client' });
    }
    const server = await this.readServer(context.intent.serverId);
    if (!server) {
      return {
        outcome: 'failed',
        failure: preflightFailure('SERVER_NOT_FOUND', 'The desired server no longer exists'),
      };
    }
    const expectedRevision = context.intent.targetGeneration;
    const currentRevision = revisionNumber(server.revision);
    if (currentRevision !== undefined && currentRevision !== expectedRevision) {
      return this.staleOutcome(context.intent);
    }
    if (context.intent.kind === 'server.connect') {
      try {
        await this.connectWithTrustToken(context.client, server, context.intent, context.signal);
      } catch (error) {
        if (error instanceof ServerRevisionChangedError) {
          return this.staleOutcome(context.intent);
        }
        throw error;
      }
      return { outcome: 'succeeded', observedGeneration: context.intent.targetGeneration };
    }
    const options = this.options(context.intent.request);
    if (
      !(await this.projectServer(server.id, expectedRevision, {
        preflight_status: 'running',
        status: 'unknown',
      }))
    ) {
      return this.staleOutcome(context.intent);
    }
    try {
      const report = await this.runPreflight(context.client, server, options, context.signal);
      if (
        !(await this.projectServer(server.id, expectedRevision, {
          status: 'online',
          last_seen_at: sql<Date>`clock_timestamp()`,
          last_error: null,
          preflight_status: 'passed',
          preflight_checked_at: sql<Date>`clock_timestamp()`,
          preflight_report: JSON.stringify(report),
        }))
      ) {
        return this.staleOutcome(context.intent);
      }
      return { outcome: 'succeeded', observedGeneration: context.intent.targetGeneration };
    } catch (error) {
      if (error instanceof ServerRevisionChangedError) {
        return this.staleOutcome(context.intent);
      }
      const failure =
        error instanceof IncusError
          ? preflightFailure(error.code, error.message, error.details as Record<string, unknown>)
          : preflightFailure(
              'PREFLIGHT_FAILED',
              error instanceof Error ? error.message : String(error),
            );
      const retryable = error instanceof IncusError && error.disposition === 'retry';
      if (
        !(await this.projectServer(server.id, expectedRevision, {
          status: failure.code === 'SERVER_UNREACHABLE' ? 'unreachable' : 'unknown',
          last_error: failure.message.slice(0, 4096),
          preflight_status: retryable ? 'running' : 'failed',
          preflight_checked_at: sql<Date>`clock_timestamp()`,
          preflight_report: JSON.stringify(
            this.failureReport(
              retryable ? PreflightStatus.Running : PreflightStatus.Failed,
              failure.code,
            ),
          ),
        }))
      ) {
        return this.staleOutcome(context.intent);
      }
      throw error;
    }
  }

  private async connectWithTrustToken(
    client: IncusClientPort,
    server: ServerRow,
    intent: IntentRecord,
    signal: AbortSignal,
  ): Promise<void> {
    const reference = trustTokenReference(intent.request);
    const claimId = randomUUID();
    let claimed = false;
    let trustMutationSucceeded = false;
    let claimConsumed = false;
    let certificateId: string | undefined;
    try {
      const preparation = await this.database.transaction().execute(async (transaction) => {
        await lockServerOnboarding(transaction);
        const activeTrust = await this.readActiveCertificateTrust(server.id, transaction);
        if (!activeTrust) {
          throw new IncusError('TLS_ERROR', 'retry', {
            serverId: server.id,
            reason: 'active_certificate_missing',
          });
        }
        if (isTrustedCertificateState(activeTrust.state)) {
          return { certificateId: activeTrust.certificateId, trustToken: null as string | null };
        }
        if (!reference) {
          throw new IncusError('TRUST_TOKEN_MISSING', 'managed_failure', {
            reason: 'trust_token_reference_missing',
          });
        }

        let trustToken: string | null;
        try {
          trustToken = await this.trustTokens.claimTrustToken(server.id, reference, claimId);
          claimed = trustToken !== null;
        } catch (error) {
          if (error instanceof RedisEphemeralStateUnavailableError) {
            throw new IncusError('TRUST_TOKEN_UNAVAILABLE', 'retry', {
              reason: 'redis_ephemeral_store_unavailable',
            });
          }
          throw error;
        }
        if (!trustToken) {
          throw new IncusError('TRUST_TOKEN_MISSING', 'managed_failure', {
            reason: 'trust_token_expired_or_already_consumed',
          });
        }
        return { certificateId: activeTrust.certificateId, trustToken };
      });

      certificateId = preparation.certificateId;
      if (preparation.trustToken) {
        try {
          await readAfterTimeout(
            () =>
              requestAndWait(
                client,
                (options) =>
                  client.trustClientCertificate(preparation.trustToken!, `nyabase-${normalized(server.id)}`, {
                    ...options,
                    signal,
                  }),
                { signal },
              ),
            async () => {
              await client.getServer({ signal });
              return undefined;
            },
          );
        } catch (error) {
          throw this.classifyTrustMutationFailure(error);
        }
        trustMutationSucceeded = true;
        await this.database.transaction().execute(async (transaction) => {
          await lockServerOnboarding(transaction);
          await this.markTrustState(
            transaction,
            preparation.certificateId,
            server.id,
            CertificateTrustState.Trusted,
          );
        });

        let consumed: boolean;
        try {
          consumed = await this.trustTokens.consumeClaimedTrustToken(
            server.id,
            reference!,
            claimId,
          );
        } catch (error) {
          if (error instanceof RedisEphemeralStateUnavailableError) {
            throw new IncusError('TRUST_TOKEN_UNAVAILABLE', 'retry', {
              reason: 'redis_ephemeral_store_unavailable_after_trust',
            });
          }
          throw error;
        }
        if (!consumed) {
          throw new IncusError('TRUST_TOKEN_UNAVAILABLE', 'retry', {
            reason: 'trust_token_commit_lost_after_trust',
          });
        }
        claimConsumed = true;
      }

      const expectedFingerprint =
        typeof intent.request?.expectedServerCertFingerprint === 'string'
          ? intent.request.expectedServerCertFingerprint
          : undefined;
      await this.connectWithPropagationRetry(
        client,
        server,
        expectedFingerprint,
        revisionNumber(server.revision),
        signal,
      );
      await this.persistVerifiedTrust(certificateId, server.id);
    } finally {
      if (claimed && !claimConsumed && !trustMutationSucceeded) {
        try {
          if (reference) {
            await this.trustTokens.releaseClaimedTrustToken(server.id, reference, claimId);
          }
        } catch {
          // The short Redis claim lease makes a failed release retryable.
        }
      }
    }
  }

  private async connectWithPropagationRetry(
    client: IncusClientPort,
    server: ServerRow,
    expectedFingerprint: string | undefined,
    expectedRevision: number | undefined,
    signal: AbortSignal,
  ): Promise<IncusResponse<IncusSchema<'Server'>>> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.connect(client, server, expectedFingerprint, expectedRevision, signal);
      } catch (error) {
        const delayMs = TRUST_PROPAGATION_RETRY_DELAYS_MS[attempt];
        if (!(error instanceof IncusError) || error.code !== 'TLS_ERROR' || delayMs === undefined) {
          throw error;
        }
        await this.waitForTrustPropagation(delayMs, signal);
      }
    }
  }

  private async connect(
    client: IncusClientPort,
    server: ServerRow,
    expectedFingerprint?: string,
    expectedRevision?: number,
    signal?: AbortSignal,
  ): Promise<IncusResponse<IncusSchema<'Server'>>> {
    let response;
    try {
      response = signal ? await client.getServer({ signal }) : await client.getServer();
    } catch (error) {
      if (
        error instanceof IncusError &&
        (error.code === 'TLS_ERROR' || error.code === 'TLS_PIN_MISMATCH')
      ) {
        await this.markStatus(server.id, 'unknown', error.message, expectedRevision);
      } else {
        await this.markUnreachable(server.id, error, expectedRevision);
      }
      throw error;
    }
    const environment = response.metadata.environment;
    const actualName = environment?.server_name;
    const actualFingerprint = environment?.certificate_fingerprint
      ?.replace(/[:-\s]/g, '')
      .toLowerCase();
    if (actualName && actualName !== server.name) {
      await this.markStatus(
        server.id,
        'unknown',
        'Incus server identity mismatch',
        expectedRevision,
      );
      throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
        expectedName: server.name,
        actualName,
      });
    }
    const pinnedFingerprint = expectedFingerprint ?? server.server_cert_fingerprint ?? undefined;
    if (
      (expectedFingerprint &&
        (!actualFingerprint ||
          normalizeCertificateFingerprint(expectedFingerprint) !== actualFingerprint)) ||
      (pinnedFingerprint &&
        (!actualFingerprint ||
          normalizeCertificateFingerprint(pinnedFingerprint) !== actualFingerprint))
    ) {
      await this.markStatus(
        server.id,
        'unknown',
        'Incus certificate fingerprint mismatch',
        expectedRevision,
      );
      throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
        ...(expectedFingerprint || pinnedFingerprint
          ? { expectedFingerprint: expectedFingerprint ?? pinnedFingerprint }
          : {}),
        ...(actualFingerprint ? { actualFingerprint } : {}),
      });
    }
    if (
      !(await this.projectServer(server.id, expectedRevision, {
        status: 'online',
        server_cert_fingerprint: actualFingerprint ?? server.server_cert_fingerprint,
        incus_version: environment?.server_version ?? null,
        api_extensions: response.metadata.api_extensions ?? [],
        last_seen_at: sql<Date>`clock_timestamp()`,
        last_error: null,
      }))
    ) {
      throw new ServerRevisionChangedError();
    }
    return response;
  }

  private async waitForTrustPropagation(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new IncusError('INCUS_TIMEOUT', 'retry', {
        phase: 'trust_propagation',
      });
    }
    await new Promise<void>((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const abort = (): void => {
        if (timer) clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(
          new IncusError('INCUS_TIMEOUT', 'retry', {
            phase: 'trust_propagation',
          }),
        );
      };
      timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, delayMs);
      timer.unref?.();
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  private async readActiveCertificateTrust(
    serverId: string,
    executor: ServerPreflightExecutor,
  ): Promise<ActiveCertificateTrust | null> {
    const certificate = await executor
      .selectFrom('system.incus_client_certificates')
      .select('id')
      .where('state', '=', CertificateState.Active)
      .forUpdate()
      .executeTakeFirst();
    if (!certificate) return null;
    const trust = await executor
      .selectFrom('system.incus_client_certificate_trusts')
      .select('state')
      .where('certificate_id', '=', certificate.id)
      .where('server_id', '=', serverId)
      .forUpdate()
      .executeTakeFirst();
    return {
      certificateId: certificate.id,
      state: (trust?.state as CertificateTrustState | undefined) ?? null,
    };
  }

  private async markTrustState(
    executor: ServerPreflightExecutor,
    certificateId: string,
    serverId: string,
    state: CertificateTrustState,
  ): Promise<void> {
    await executor
      .insertInto('system.incus_client_certificate_trusts')
      .values({
        certificate_id: certificateId,
        server_id: serverId,
        state,
        last_error: null,
        observed_at: state === CertificateTrustState.Verified ? new Date() : null,
      })
      .onConflict((conflict) =>
        conflict.columns(['certificate_id', 'server_id']).doUpdateSet({
          state,
          last_error: null,
          observed_at: state === CertificateTrustState.Verified ? new Date() : null,
        }),
      )
      .execute();
  }

  private async persistVerifiedTrust(
    certificateId: string | undefined,
    serverId: string,
  ): Promise<void> {
    if (!certificateId) {
      throw new IncusError('TLS_ERROR', 'retry', {
        serverId,
        reason: 'active_certificate_id_missing',
      });
    }
    await this.database.transaction().execute(async (transaction) => {
      await lockServerOnboarding(transaction);
      await this.markTrustState(
        transaction,
        certificateId,
        serverId,
        CertificateTrustState.Verified,
      );
    });
  }

  private classifyTrustMutationFailure(error: unknown): unknown {
    if (
      error instanceof IncusError &&
      (error.code === 'INCUS_TIMEOUT' ||
        error.code === 'SERVER_UNREACHABLE' ||
        error.code === 'TLS_ERROR' ||
        error.code === 'TLS_PIN_MISMATCH')
    ) {
      return error;
    }
    if (error instanceof IncusError) {
      return new IncusError('TRUST_TOKEN_REJECTED', 'managed_failure', {
        reason: error.code,
      });
    }
    return error;
  }

  private async runPreflight(
    client: IncusClientPort,
    server: ServerRow,
    options: PreflightOptions,
    signal: AbortSignal,
  ): Promise<PreflightReport> {
    const expectedRevision = revisionNumber(server.revision);
    const serverResponse = await this.connect(client, server, undefined, expectedRevision, signal);
    const environment = serverResponse.metadata.environment;
    const pools = await client.listStoragePools(1, { signal });
    const resources = await client.getResources({ signal });
    const storage = resources.metadata.storage ?? {};
    const systemPool = server.system_pool_id
      ? await this.database
          .selectFrom('infra.storage_pools')
          .select(['incus_name', 'server_id', 'registered'])
          .where('id', '=', server.system_pool_id)
          .executeTakeFirst()
      : undefined;
    if (
      !systemPool ||
      systemPool.server_id !== server.id ||
      !systemPool.registered ||
      !pools.metadata.some((pool) => pool.name === systemPool.incus_name)
    ) {
      throw new IncusError('MISSING_STORAGE_POOL', 'managed_failure', {
        serverId: server.id,
        systemPoolId: server.system_pool_id,
      });
    }
    let nodeMetrics: {
      readonly status: 'online' | 'unreachable' | 'unknown';
      readonly report?: Record<string, unknown> & {
        readonly samples?: readonly NodeMetricSample[];
      };
    };
    let nodeMetricsFailure: unknown = null;
    try {
      nodeMetrics = await this.pullNodeMetrics(server, signal, expectedRevision);
    } catch (error) {
      nodeMetricsFailure = error;
      nodeMetrics = {
        status: 'unreachable',
        report: {
          warning: 'node_metrics_unavailable',
        },
      };
    }
    const metricEvidence = nodeMetricsFailure ? undefined : nodeMetrics.report;
    const network = await this.checks.checkNetworkPrerequisites(server.id, metricEvidence);
    const gpu =
      metricEvidence || server.preflight_status !== 'passed'
        ? await this.checks.checkGpuToolkit(
            server.id,
            resources.metadata,
            metricEvidence,
            expectedRevision,
          )
        : {
            serverId: server.id,
            gpuRuntime: 'unknown',
            gpuCount: resources.metadata.gpu?.cards?.length ?? 0,
          };
    if (
      server.preflight_status !== 'passed' &&
      (network.networkPrerequisites !== true || gpu.gpuRuntime === 'fail')
    ) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason:
          gpu.gpuRuntime === 'fail'
            ? 'gpu_toolkit_not_available'
            : 'network_prerequisites_not_satisfied',
        network: JSON.stringify(network).slice(0, 2048),
        gpu: JSON.stringify(gpu).slice(0, 2048),
      });
    }
    const reportEvidence: Record<string, unknown> = {
      storage,
      storagePools: pools.metadata.map((pool) => ({
        name: pool.name,
        driver: pool.driver,
        status: pool.status,
      })),
      network,
      gpu,
      nodeMetricsWarning: nodeMetricsFailure
        ? nodeMetricsFailure instanceof Error
          ? nodeMetricsFailure.message
          : String(nodeMetricsFailure)
        : null,
      server: resources.metadata.system ?? {},
    };
    reportEvidence.nodeMetrics = nodeMetrics;
    const checks: ReportChecks = {
      api: 'pass',
      parentInterface: server.parent_interface ? 'pass' : 'fail',
      gpuRuntime:
        gpu.gpuRuntime === 'not_applicable'
          ? 'not_applicable'
          : gpu.gpuRuntime === 'pass'
            ? 'pass'
            : 'fail',
      forwarding: network.forwarding === true ? 'pass' : 'fail',
      nftables: environment?.firewall === 'nftables' ? 'pass' : 'fail',
      rpFilter: network.rpFilter === true ? 'pass' : 'fail',
      networkPrerequisites: network.networkPrerequisites === true ? 'pass' : 'fail',
      storagePool: 'pass',
      simplestreamsImage: 'fail',
      routedAddress: 'fail',
      egress: 'fail',
      nodeMetrics: nodeMetricsFailure ? 'warn' : nodeMetrics.status === 'online' ? 'pass' : 'fail',
    };
    const probeOptions = {
      ...options,
      probePoolName: options.probePoolName || systemPool?.incus_name || '',
    };
    if (
      (!probeOptions.probeImageAlias && !probeOptions.probeImageFingerprint) ||
      !probeOptions.probePoolName
    ) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_probe_options_missing',
      });
    }
    if (
      (probeOptions.probeImageAlias || probeOptions.probeImageFingerprint) &&
      probeOptions.probePoolName
    ) {
      const probeName = `nyabase-preflight-${normalized(server.id)}`;
      const parentInterface = server.parent_interface;
      if (!parentInterface) {
        throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
          reason: 'preflight_macvlan_parent_missing',
        });
      }
      await this.cleanupStaleProbe(client, probeName, server.id, signal);
      let created = false;
      let cleanupError: unknown;
      let confirmedProbe: IncusSchema<'InstanceFull'> | undefined;
      const poolNetwork = await this.lookupIpPoolNetwork(server.id);
      if (!poolNetwork) {
        throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
          reason: 'preflight_ip_pool_missing',
        });
      }
      try {
        const confirmProbeIdentity = async (): Promise<IncusSchema<'InstanceFull'>> => {
          const probe = (await client.getInstanceFull(probeName, { signal })).metadata;
          if (
            probe.config?.[MANAGED_PROBE_KEY] !== 'true' ||
            probe.config?.[PROBE_SERVER_KEY] !== normalized(server.id)
          ) {
            throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
              probeName,
            });
          }
          return probe;
        };
        const confirmProbe = async (): Promise<IncusSchema<'InstanceFull'>> => {
          const probe = await confirmProbeIdentity();
          // create then start is async: identity can appear while status is still Stopped.
          // Confirm Running before egress/cleanup or cleanup skips stop and DELETE 400s.
          const liveStatus = (
            probe.state?.status ?? probe.status ?? ''
          ).toLowerCase();
          if (liveStatus !== 'running') {
            throw new Error(`preflight probe not running yet (${liveStatus || 'unknown'})`);
          }
          confirmedProbe = probe;
          return probe;
        };
        const createProbe = () =>
          requestAndWait(
            client,
            (requestOptions) =>
              client.createInstance(
                {
                  name: probeName,
                  type: 'container',
                  profiles: [],
                  source: {
                    type: 'image',
                    ...(probeOptions.probeImageAlias
                      ? { alias: probeOptions.probeImageAlias }
                      : { fingerprint: probeOptions.probeImageFingerprint }),
                    server: probeOptions.sourceServer,
                    protocol: probeOptions.sourceServer ? 'simplestreams' : undefined,
                  },
                  config: {
                    [MANAGED_PROBE_KEY]: 'true',
                    [PROBE_SERVER_KEY]: normalized(server.id),
                    // Debian+wget TLS can SIGKILL (rc 137) under tight/default pressure.
                    'limits.memory': PREFLIGHT_PROBE_MEMORY,
                    'security.privileged': 'false',
                  },
                  devices: {
                    root: {
                      type: 'disk',
                      path: '/',
                      pool: probeOptions.probePoolName,
                      size: '1073741824',
                    },
                    eth0: {
                      type: 'nic',
                      nictype: 'macvlan',
                      mode: 'bridge',
                      name: 'eth0',
                      parent: parentInterface,
                      hwaddr: deriveInstanceHwaddr(probeHardwareId(server.id)),
                    },
                  },
                  start: false,
                },
                { ...requestOptions, signal },
              ),
            { signal },
          );
        try {
          await readAfterTimeout(createProbe, async () => {
            await confirmProbeIdentity();
            return undefined;
          });
        } catch (error) {
          if (!isOperationWaitNotFound(error)) throw error;
          await confirmProbeIdentity();
        }
        created = true;
        try {
          await readAfterTimeout(
            () =>
              requestAndWait(
                client,
                (requestOptions) =>
                  client.updateInstanceState(
                    probeName,
                    { action: 'start', force: false },
                    { ...requestOptions, signal },
                  ),
                { signal },
              ),
            async () => {
              await confirmProbe();
              return undefined;
            },
          );
        } catch (error) {
          if (!isOperationWaitNotFound(error)) throw error;
          await confirmProbe();
        }
        created = true;
        const probe =
          confirmedProbe ?? (await client.getInstanceFull(probeName, { signal })).metadata;
        checks.simplestreamsImage = 'pass';
        await applyGuestNetwork(
          client,
          probeName,
          {
            address: probeOptions.probeAddress,
            prefixLength: poolNetwork.prefixLength,
            gateway: poolNetwork.gateway,
            dnsServers: [],
          },
          signal,
        );
        checks.routedAddress =
          probe.config?.[PROBE_SERVER_KEY] === normalized(server.id) ? 'pass' : 'fail';
        const egress = await this.checks.checkEgress(server.id, client, probeName, signal);
        if (egress.status === 'pass') checks.egress = 'pass';
        reportEvidence.egress = egress;
      } finally {
        if (created) {
          try {
            await this.stopAndDeleteProbe(client, probeName, signal);
          } catch (error) {
            cleanupError = error;
          }
        }
      }
      if (cleanupError) {
        if (
          !(await this.projectServer(server.id, expectedRevision, {
            status: 'unknown',
            last_error: `Preflight cleanup failed: ${String(cleanupError).slice(0, 3800)}`,
            preflight_status: 'failed',
            preflight_checked_at: sql<Date>`clock_timestamp()`,
            preflight_report: JSON.stringify(
              this.failureReport(PreflightStatus.Failed, FailureCode.PreflightCleanupFailed),
            ),
          }))
        ) {
          throw new ServerRevisionChangedError();
        }
        throw new IncusError('PREFLIGHT_CLEANUP_FAILED', 'managed_failure', {
          error: String(cleanupError).slice(0, 1024),
          ...(cleanupError instanceof IncusError
            ? { code: cleanupError.code, details: cleanupError.details }
            : {}),
        });
      }
    }
    return this.successReport(checks);
  }

  private async pullNodeMetrics(
    server: ServerRow,
    signal: AbortSignal,
    expectedRevision?: number,
  ): Promise<{
    readonly status: 'online' | 'unreachable' | 'unknown';
    readonly report?: Record<string, unknown>;
  }> {
    if (!server.node_metrics_endpoint || !server.node_metrics_token_ciphertext) {
      if (
        !(await this.projectServer(server.id, expectedRevision, {
          node_metrics_status: 'unconfigured',
          node_metrics_last_error: 'Node metrics endpoint or token is not configured',
        }))
      ) {
        throw new ServerRevisionChangedError();
      }
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'node_metrics_pull_unconfigured',
      });
    }
    try {
      const result = await this.nodeMetrics.pull(
        server.id,
        server.node_metrics_endpoint,
        server.node_metrics_token_ciphertext,
        signal,
      );
      if (result.status !== 'online') {
        if (
          !(await this.projectServer(server.id, expectedRevision, {
            node_metrics_status: result.status,
            node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
            node_metrics_last_error: `Node metrics status: ${result.status}`,
          }))
        ) {
          throw new ServerRevisionChangedError();
        }
        throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
          reason: 'node_metrics_pull_not_online',
          status: result.status,
        });
      }
      if (
        !(await this.projectServer(server.id, expectedRevision, {
          node_metrics_status: 'online',
          node_metrics_last_success_at: sql<Date>`clock_timestamp()`,
          node_metrics_outage_since: null,
          node_metrics_last_error: null,
        }))
      ) {
        throw new ServerRevisionChangedError();
      }
      return result;
    } catch (error) {
      if (error instanceof ServerRevisionChangedError) throw error;
      if (error instanceof IncusError) throw error;
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : 'NODE_METRICS_PULL_FAILED';
      if (
        !(await this.projectServer(server.id, expectedRevision, {
          node_metrics_status: 'unknown',
          node_metrics_outage_since: sql<Date>`coalesce(node_metrics_outage_since, clock_timestamp())`,
          node_metrics_last_error: `Node metrics pull failed: ${code}`,
        }))
      ) {
        throw new ServerRevisionChangedError();
      }
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'node_metrics_pull_failed',
        code,
      });
    }
  }

  private async cleanupStaleProbe(
    client: IncusClientPort,
    probeName: string,
    serverId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let existing: IncusSchema<'InstanceFull'>;
    try {
      existing = (await client.getInstanceFull(probeName, { signal })).metadata;
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') return;
      throw error;
    }
    const config = existing.config ?? {};
    if (config[MANAGED_PROBE_KEY] !== 'true' || config[PROBE_SERVER_KEY] !== normalized(serverId)) {
      throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
        probeName,
      });
    }
    await this.stopAndDeleteProbe(client, probeName, signal);
  }

  private async stopAndDeleteProbe(
    client: IncusClientPort,
    probeName: string,
    signal: AbortSignal,
  ): Promise<void> {
    let liveStatus = '';
    try {
      liveStatus = (
        (await client.getInstanceState(probeName, { signal })).metadata.status ?? ''
      ).toLowerCase();
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') return;
      throw error;
    }
    if (liveStatus === 'running') {
      await readAfterTimeout(
        () =>
          requestAndWait(client, (options) =>
            client.updateInstanceState(
              probeName,
              { action: 'stop', force: true },
              { ...options, signal },
            ),
          ),
        async () => {
          const state = (await client.getInstanceState(probeName, { signal })).metadata;
          if (state.status?.toLowerCase() !== 'running') return undefined;
          throw new Error('preflight probe stop not confirmed');
        },
      );
    }
    await readAfterTimeout(
      () =>
        requestAndWait(client, (options) =>
          client.deleteInstance(probeName, { ...options, signal }),
        ),
      async () => {
        try {
          await client.getInstanceFull(probeName, { signal });
        } catch (error) {
          if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') return undefined;
          throw error;
        }
        throw new Error('preflight probe still exists');
      },
    );
    try {
      await client.getInstanceFull(probeName, { signal });
    } catch (error) {
      if (error instanceof IncusError && error.code === 'INCUS_NOT_FOUND') return;
      throw error;
    }
    throw new IncusError('PREFLIGHT_CLEANUP_FAILED', 'managed_failure', {
      probeName,
      reason: 'probe_still_present',
    });
  }

  private options(request: Record<string, unknown> | null): PreflightOptions {
    const value = isRecord(request?.preflight) ? request.preflight : request;
    const stringValue = (key: string): string | undefined =>
      isRecord(value) && typeof value[key] === 'string' && value[key].trim()
        ? String(value[key]).trim()
        : undefined;
    return {
      probeImageAlias:
        stringValue('probeImageAlias') ?? this.config.get<string>('incus.preflightImageAlias'),
      probeImageFingerprint:
        stringValue('probeImageFingerprint') ??
        this.config.get<string>('incus.preflightImageFingerprint'),
      probePoolName: stringValue('probePoolName') ?? '',
      probeAddress: stringValue('probeAddress') ?? '169.254.255.254',
      sourceServer:
        stringValue('sourceServer') ?? this.config.get<string>('incus.preflightSourceServer'),
    };
  }

  private successReport(checks: ReportChecks): PreflightReport {
    const controlReady = Object.entries(checks).every(([name, value]) => {
      if (name === 'gpuRuntime') return value === 'pass' || value === 'not_applicable';
      if (name === 'nodeMetrics') return value === 'pass' || value === 'warn';
      if (name === 'forwarding' || name === 'rpFilter') return true;
      return value === 'pass';
    });
    return {
      status: PreflightStatus.Passed,
      controlReady,
      checks,
      failureCode: null,
      checkedAt: new Date().toISOString(),
    };
  }

  private failureReport(
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
        gpuRuntime: 'fail',
        forwarding: 'fail',
        nftables: 'fail',
        rpFilter: 'fail',
        networkPrerequisites: 'fail',
        storagePool: 'fail',
        simplestreamsImage: 'fail',
        routedAddress: 'fail',
        egress: 'fail',
        nodeMetrics: 'fail',
      },
      failureCode,
      checkedAt: status === PreflightStatus.Running ? null : new Date().toISOString(),
    };
  }

  private staleOutcome(intent: IntentRecord): ReconcileOutcome {
    return {
      outcome: 'succeeded',
      observedGeneration: intent.targetGeneration,
      stale: true,
    };
  }

  private async lookupIpPoolNetwork(
    serverId: string,
  ): Promise<{ readonly gateway: string; readonly prefixLength: number } | undefined> {
    const row = await this.database
      .selectFrom('infra.ip_pool_servers as binding')
      .innerJoin('infra.ip_pools as pool', 'pool.id', 'binding.pool_id')
      .select(['pool.gateway', 'pool.cidr'])
      .where('binding.server_id', '=', serverId)
      .orderBy('pool.created_at', 'asc')
      .orderBy('pool.id', 'asc')
      .executeTakeFirst();
    const gateway = typeof row?.gateway === 'string' ? row.gateway.trim() : '';
    const cidr = typeof row?.cidr === 'string' ? row.cidr.trim() : '';
    const prefixLength = parseCidrPrefix(cidr);
    if (!gateway || prefixLength === undefined) return undefined;
    return { gateway: gateway.includes('/') ? gateway.split('/')[0]! : gateway, prefixLength };
  }

  private async projectServer(
    serverId: string,
    expectedRevision: number | undefined,
    values: Record<string, unknown>,
  ): Promise<boolean> {
    const query = this.database
      .updateTable('infra.servers')
      .set(values as never)
      .where((expression) =>
        expectedRevision === undefined
          ? expression('id', '=', serverId)
          : expression.and([
              expression('id', '=', serverId),
              expression('revision', '=', String(expectedRevision)),
            ]),
      );
    const result = await query.execute();
    if (!Array.isArray(result)) return true;
    const updateResult = result[0] as { readonly numUpdatedRows?: number | bigint } | undefined;
    return updateResult?.numUpdatedRows === undefined || Number(updateResult.numUpdatedRows) > 0;
  }

  private readServer(id: string): Promise<ServerRow | undefined> {
    return this.database
      .selectFrom('infra.servers')
      .select([
        'id',
        'name',
        'parent_interface',
        'server_cert_fingerprint',
        'node_metrics_endpoint',
        'node_metrics_token_ciphertext',
        'status',
        'system_pool_id',
        'preflight_status',
        'revision',
      ])
      .where('id', '=', id)
      .executeTakeFirst();
  }

  private async markUnreachable(
    id: string,
    error: unknown,
    expectedRevision?: number,
  ): Promise<void> {
    await this.markStatus(
      id,
      'unreachable',
      error instanceof Error ? error.message : String(error),
      expectedRevision,
    );
  }

  private async markStatus(
    id: string,
    status: 'online' | 'unreachable' | 'unknown',
    lastError: string | null,
    expectedRevision?: number,
  ): Promise<void> {
    await this.projectServer(id, expectedRevision, {
      status,
      last_error: lastError?.slice(0, 4096) ?? null,
    });
  }
}

const MANAGED_PROBE_KEY = 'user.nyabase.preflight';
const PROBE_SERVER_KEY = 'user.nyabase.server_id';
/** Headroom for Debian probe boot + wget TLS; rc 137 was SIGKILL under pressure. */
const PREFLIGHT_PROBE_MEMORY = '256MiB';

function revisionNumber(value: string | number | bigint | undefined): number | undefined {
  if (value === undefined) return undefined;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}
