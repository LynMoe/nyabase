import { Inject, Injectable } from '@nestjs/common';
import { canonicalPciAddress, MAX_NODE_METRICS_BODY_BYTES } from '@nyabase/common';
import type { NodeMetricSample } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import {
  IncusError,
  requestAndWait,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import type {
  PreflightChecksPort,
} from './server-preflight-reconciler.service.js';

const NETWORK_METRICS = {
  forwarding: 'nyabase_node_network_forwarding',
  rpFilter: 'nyabase_node_network_rp_filter',
  fib: 'nyabase_node_network_fib_rule_present',
} as const;

const GPU_RUNTIME_METRIC = 'nyabase_node_gpu_util_ratio';
@Injectable()
export class IncusPreflightChecksAdapter implements PreflightChecksPort {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
  ) {}

  async checkNetworkPrerequisites(
    serverId: string,
    evidence?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const server = await this.database
      .selectFrom('infra.servers')
      .select('parent_interface')
      .where('id', '=', serverId)
      .executeTakeFirst();
    const parentInterface = server?.parent_interface;
    const samples = metricSamples(evidence);
    const forwarding = metricPasses(
      matchingNetworkSample(samples, NETWORK_METRICS.forwarding, parentInterface),
    );
    const rpFilter = metricPasses(
      matchingNetworkSample(samples, NETWORK_METRICS.rpFilter, parentInterface),
    );
    const fib = metricPasses(
      matchingNetworkSample(samples, NETWORK_METRICS.fib, parentInterface),
    );
    return {
      serverId,
      forwarding,
      rpFilter,
      fib,
      // Macvlan LAN mode uses parent_interface as the control gate. forwarding,
      // rp_filter, and FIB remain diagnostic and must not fail first admission.
      networkPrerequisites: Boolean(parentInterface),
    };
  }

  async checkGpuToolkit(
    serverId: string,
    resources: IncusSchema<'Resources'>,
    evidence?: Record<string, unknown>,
    expectedRevision?: number,
  ): Promise<Record<string, unknown>> {
    const cards = resources.gpu?.cards ?? [];
    const updateRuntimeAvailability = async (available: boolean): Promise<void> => {
      const query = this.database
        .updateTable('infra.servers')
        .set({ gpu_runtime_available: available })
        .where((expression) => expectedRevision === undefined
          ? expression('id', '=', serverId)
          : expression.and([
            expression('id', '=', serverId),
            expression('revision', '=', String(expectedRevision)),
          ]));
      await query.execute();
    };
    // Only NVIDIA cards participate in the GPU runtime gate. Hosts commonly
    // also expose AST/display adapters that Incus lists without nvidia.*.
    const nvidiaCards = cards.filter((card) => card.nvidia !== undefined);
    if (nvidiaCards.length === 0) {
      await updateRuntimeAvailability(false);
      return {
        serverId,
        gpuRuntime: 'not_applicable',
        gpuCount: cards.length,
        nvidiaCards: 0,
      };
    }
    const healthyGpuPci = new Set(
      metricSamples(evidence)
        .filter((sample) => (
          sample.name === GPU_RUNTIME_METRIC
          && Number.isFinite(sample.value)
          && typeof sample.labels.gpu_pci === 'string'
        ))
        .map((sample) => normalizeGpuPci(sample.labels.gpu_pci))
        .filter((address): address is string => address !== null),
    );
    const missingGpuPci = nvidiaCards
      .map((card) => card.pci_address)
      .filter((address): address is string => typeof address === 'string')
      .map(normalizeGpuPci)
      .filter((address): address is string => address !== null)
      .filter((address) => !healthyGpuPci.has(address));
    const cardsWithoutPci = nvidiaCards.filter((card) => typeof card.pci_address !== 'string').length;
    const exporterGpuSamples = healthyGpuPci.size > 0;
    await updateRuntimeAvailability(true);
    return {
      serverId,
      gpuRuntime: 'pass',
      gpuCount: cards.length,
      nvidiaCards: nvidiaCards.length,
      missingGpuPci,
      cardsWithoutPci,
      exporterGpuSamples,
    };
  }

  async checkEgress(
    serverId: string,
    client: IncusClientPort,
    probeName: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const target = this.config.get<string>('incus.preflightEgressUrl');
    if (!target) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_egress_target_unconfigured',
        serverId,
      });
    }
    const url = parseEgressTarget(target);
    const result = await requestAndWait(
      client,
      (options) => client.execInstance(
        probeName,
        {
          command: [
            'wget',
            '-q',
            '-T',
            '10',
            '-O',
            '/dev/null',
            url.toString(),
          ],
          'record-output': true,
        },
        options,
      ),
      {
        signal,
        timeoutMs: this.config.get<number>('incus.operationWaitTimeoutMs'),
      },
    );
    if (result.kind !== 'completed') {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_egress_operation_not_async',
        serverId,
      });
    }
    const operation = result.metadata as unknown as Record<string, unknown>;
    const nestedMetadata = operation.metadata;
    const returnCode = operation.return
      ?? (
        nestedMetadata && typeof nestedMetadata === 'object' && !Array.isArray(nestedMetadata)
          ? (nestedMetadata as Record<string, unknown>).return
          : undefined
      );
    if (typeof returnCode !== 'number' || returnCode !== 0) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_egress_failed',
        serverId,
        returnCode: typeof returnCode === 'number' ? returnCode : null,
      });
    }
    return {
      serverId,
      status: 'pass',
      target: `${url.protocol}//${url.host}${url.pathname || '/'}`,
      responseBytesLimit: MAX_NODE_METRICS_BODY_BYTES,
    };
  }
}

function metricSamples(evidence: Record<string, unknown> | undefined): readonly NodeMetricSample[] {
  const samples = evidence?.samples;
  if (!Array.isArray(samples)) return [];
  return samples.filter((sample): sample is NodeMetricSample => (
    typeof sample === 'object'
    && sample !== null
    && !Array.isArray(sample)
    && typeof (sample as Record<string, unknown>).name === 'string'
    && typeof (sample as Record<string, unknown>).value === 'number'
    && Number.isFinite((sample as Record<string, unknown>).value)
    && typeof (sample as Record<string, unknown>).labels === 'object'
    && (sample as Record<string, unknown>).labels !== null
  ));
}

function matchingNetworkSample(
  samples: readonly NodeMetricSample[],
  name: string,
  parentInterface: string | null | undefined,
): number | undefined {
  if (!parentInterface) return undefined;
  return samples.find((sample) => (
    sample.name === name
    && sample.labels.interface === parentInterface
  ))?.value;
}

/**
 * Network sysctl / FIB gauges pass when the metric is present and >= 1.
 *
 * For `nyabase_node_network_rp_filter` this means "enabled" (strict=1 or
 * loose=2), never disabled (0). Plan N3 text says prefer =1; Incus 6.0.4
 * phase-0 measured new routed veths at 2 even with all/default/parent=1, and
 * forged sources were still blocked by structural isolation + FIB (+ loose).
 * Product therefore accepts >=1; see session rp-filter-policy.md.
 */
function metricPasses(value: number | undefined): boolean {
  return value !== undefined && value >= 1;
}

function normalizeGpuPci(value: string): string | null {
  return canonicalPciAddress(value.trim());
}

function parseEgressTarget(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'preflight_egress_target_invalid',
    });
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'preflight_egress_target_must_be_fixed_https',
    });
  }
  return url;
}
