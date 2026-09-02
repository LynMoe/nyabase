import { Inject, Injectable } from '@nestjs/common';
import { MAX_NODE_METRICS_BODY_BYTES } from '@nyabase/common';
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
  isBridge: 'nyabase_node_network_is_bridge',
  ipv4Present: 'nyabase_node_network_ipv4_present',
  bridgeSlave: 'nyabase_node_network_bridge_slave',
  nftAvailable: 'nyabase_node_network_nft_available',
} as const;

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
    const parentInterface = server?.parent_interface?.trim() || null;
    const samples = metricSamples(evidence);
    const isBridge = parentInterface
      ? matchingNetworkSample(samples, NETWORK_METRICS.isBridge, parentInterface) === 1
      : false;
    const nftAvailable = unlabeledSample(samples, NETWORK_METRICS.nftAvailable) === 1;
    const slaves = parentInterface
      ? samples
        .filter((sample) => (
          sample.name === NETWORK_METRICS.bridgeSlave
          && sample.labels.bridge === parentInterface
          && sample.value === 1
          && typeof sample.labels.interface === 'string'
          && sample.labels.interface.length > 0
        ))
        .map((sample) => sample.labels.interface)
      : [];
    const ipv4Present: Record<string, boolean> = {};
    for (const sample of samples) {
      if (sample.name !== NETWORK_METRICS.ipv4Present) continue;
      const iface = sample.labels.interface;
      if (!iface) continue;
      ipv4Present[iface] = sample.value === 1;
    }
    const slavesWithIpv4 = slaves.filter((iface) => ipv4Present[iface] === true);
    const slavesWithUnknownIpv4 = slaves.filter((iface) => !(iface in ipv4Present));
    const hasUplink = slaves.length > 0;
    const networkPrerequisites = Boolean(
      parentInterface
      && isBridge
      && nftAvailable
      && hasUplink
      && slavesWithIpv4.length === 0
      && slavesWithUnknownIpv4.length === 0,
    );
    return {
      serverId,
      parentInterface,
      isBridge,
      nftAvailable,
      slaves,
      ipv4Present,
      slavesWithIpv4,
      slavesWithUnknownIpv4,
      hasUplink,
      networkPrerequisites,
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
    const returnCode = operationReturnCode(result.metadata);
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

  async checkGuestCanReachHost(
    serverId: string,
    client: IncusClientPort,
    probeName: string,
    hostAddress: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const result = await requestAndWait(
      client,
      (options) => client.execInstance(
        probeName,
        {
          command: ['ping', '-c', '1', '-W', '3', hostAddress],
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
        reason: 'preflight_guest_cannot_reach_host',
        serverId,
      });
    }
    const returnCode = operationReturnCode(result.metadata);
    const output = operationOutputText(result.metadata);
    if (returnCode === 127 || /ping: not found|command not found/i.test(output)) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_probe_ping_missing',
        serverId,
        returnCode: returnCode ?? null,
      });
    }
    if (typeof returnCode !== 'number' || returnCode !== 0) {
      throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
        reason: 'preflight_guest_cannot_reach_host',
        serverId,
        returnCode: typeof returnCode === 'number' ? returnCode : null,
      });
    }
    return {
      serverId,
      status: 'pass',
      hostAddress,
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

function unlabeledSample(
  samples: readonly NodeMetricSample[],
  name: string,
): number | undefined {
  return samples.find((sample) => (
    sample.name === name
    && Object.keys(sample.labels).length === 0
  ))?.value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationReturnCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.return === 'number' && Number.isSafeInteger(value.return)) {
    return value.return;
  }
  return operationReturnCode(value.metadata);
}

function operationOutputText(value: unknown): string {
  if (!isRecord(value)) return '';
  const parts: string[] = [];
  for (const key of ['output', 'stdout', 'stderr', 'err', 'error']) {
    const child = value[key];
    if (typeof child === 'string') parts.push(child);
  }
  if (isRecord(value.metadata)) {
    parts.push(operationOutputText(value.metadata));
  }
  return parts.join('\n');
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
