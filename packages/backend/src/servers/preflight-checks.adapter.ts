import { isIP } from 'node:net';
import { Inject, Injectable } from '@nestjs/common';
import { MAX_NODE_METRICS_BODY_BYTES, isUsableHostInCidr, type NodeMetricSample } from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PG_DATABASE } from '../platform/persistence-pg/tokens.js';
import { NyabaseConfigService } from '../platform/config/nyabase-config.service.js';
import {
  IncusError,
  requestAndWait,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import type { IpPoolNetwork } from './server-preflight.store.js';
import { isRecord } from '../platform/domain-utils.js';

const NETWORK_METRICS = {
  isBridge: 'nyabase_node_network_is_bridge',
  ipv4Present: 'nyabase_node_network_ipv4_present',
  bridgeSlave: 'nyabase_node_network_bridge_slave',
  nftAvailable: 'nyabase_node_network_nft_available',
} as const;

@Injectable()
export class IncusPreflightChecksAdapter {
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
    const samples = metricSamplesFrom(evidence);
    const isBridge = parentInterface
      ? unlabeledOrInterfaceGauge(samples, NETWORK_METRICS.isBridge, parentInterface) === 1
      : false;
    const nftAvailable = unlabeledGauge(samples, NETWORK_METRICS.nftAvailable) === 1;
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
            '/bin/sh',
            '-c',
            'if command -v wget >/dev/null 2>&1; then wget -q -T 10 -O /dev/null "$1"; else curl -fsS -m 10 -o /dev/null "$1"; fi',
            'preflight-egress',
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

export interface ParentNetworkLookup {
  readonly network?: IncusSchema<'Network'>;
  readonly networkMissing: boolean;
  readonly state?: IncusSchema<'NetworkState'>;
  readonly stateMissing: boolean;
}

export function metricSamplesFrom(
  evidence: Record<string, unknown> | undefined,
): readonly NodeMetricSample[] {
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

export function unlabeledGauge(samples: readonly NodeMetricSample[], name: string): number | undefined {
  return samples.find((sample) => sample.name === name && Object.keys(sample.labels).length === 0)
    ?.value;
}

export function labeledGauge(
  samples: readonly NodeMetricSample[],
  name: string,
  labels: Readonly<Record<string, string>>,
): number | undefined {
  return samples.find((sample) => {
    if (sample.name !== name) return false;
    return Object.entries(labels).every(([key, value]) => sample.labels[key] === value);
  })?.value;
}

export function unlabeledOrInterfaceGauge(
  samples: readonly NodeMetricSample[],
  name: string,
  iface: string,
): number | undefined {
  return labeledGauge(samples, name, { interface: iface });
}

export function parentInterfaceExists(
  samples: readonly NodeMetricSample[],
  parentInterface: string,
  network: Record<string, unknown>,
): boolean {
  if (network.parentInterface === parentInterface) return true;
  return samples.some((sample) => sample.labels.interface === parentInterface);
}

export function isExcludedIpv4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  if (parts[0] === 127) return true;
  if (parts[0] === 169 && parts[1] === 254) return true;
  return false;
}

export function inetGlobalAddresses(
  addresses: IncusSchema<'NetworkState'>['addresses'] | undefined,
): string[] {
  if (!addresses) return [];
  const result: string[] = [];
  for (const entry of addresses) {
    if (entry.family !== 'inet' || entry.scope !== 'global') continue;
    const raw = typeof entry.address === 'string' ? entry.address.trim() : '';
    const address = raw.includes('/') ? raw.split('/')[0]! : raw;
    if (isIP(address) !== 4 || isExcludedIpv4(address)) continue;
    result.push(address);
  }
  return result;
}

export function pickHostIpv4FromList(
  addresses: readonly string[],
  pools: readonly IpPoolNetwork[],
): string | undefined {
  for (const address of addresses) {
    if (pools.some((pool) => isUsableHostInCidr(pool.cidr, address))) {
      return address;
    }
  }
  return undefined;
}

export function networkNameFromListEntry(entry: string): string {
  const trimmed = entry.trim();
  const match = /\/1\.0\/networks\/([^/]+)$/.exec(trimmed);
  return decodeURIComponent(match?.[1] ?? trimmed);
}

export function isIgnoredHostInterface(name: string): boolean {
  return /^(lo|docker0|cni.*|flannel.*|calico.*|veth.*|wg\d*|tun.*|tap.*|gre.*|gretap.*|erspan.*|dummy.*|virbr.*|incusbr.*|lxcbr.*|fwbr.*|br-.+)$/i
    .test(name);
}

export async function lookupParentNetwork(
  client: IncusClientPort,
  parentInterface: string,
  signal: AbortSignal,
): Promise<ParentNetworkLookup> {
  let network: IncusSchema<'Network'> | undefined;
  let networkMissing = false;
  try {
    network = (await client.getNetwork(parentInterface, { signal })).metadata;
  } catch (error) {
    if (!(error instanceof IncusError) || error.code !== 'INCUS_NOT_FOUND') throw error;
    networkMissing = true;
  }
  let state: IncusSchema<'NetworkState'> | undefined;
  let stateMissing = false;
  if (networkMissing) {
    stateMissing = true;
  } else {
    try {
      state = (await client.getNetworkState(parentInterface, { signal })).metadata;
    } catch (error) {
      if (!(error instanceof IncusError) || error.code !== 'INCUS_NOT_FOUND') throw error;
      stateMissing = true;
    }
  }
  return { network, networkMissing, state, stateMissing };
}

export async function listHostLanAddresses(
  client: IncusClientPort,
  parentInterface: string,
  parentLookup: ParentNetworkLookup,
  signal: AbortSignal,
): Promise<string[]> {
  const names = new Set<string>();
  if (parentInterface) names.add(parentInterface);
  try {
    const listed = (await client.listNetworks({ signal })).metadata ?? [];
    for (const entry of listed) {
      const name = networkNameFromListEntry(entry);
      if (name && !isIgnoredHostInterface(name)) names.add(name);
    }
  } catch {
    // Parent state plus exporter evidence still have to prove a pool address.
  }
  const addresses: string[] = [];
  for (const name of names) {
    if (name === parentInterface && parentLookup.state?.addresses) {
      addresses.push(...inetGlobalAddresses(parentLookup.state.addresses));
      continue;
    }
    try {
      const state = (await client.getNetworkState(name, { signal })).metadata;
      addresses.push(...inetGlobalAddresses(state?.addresses));
    } catch {
      continue;
    }
  }
  return [...new Set(addresses)];
}

export function evaluateLanBridge(input: {
  readonly parentInterface: string;
  readonly network: Record<string, unknown>;
  readonly lookup: ParentNetworkLookup;
  readonly pools: readonly IpPoolNetwork[];
  readonly samples: readonly NodeMetricSample[];
  readonly extraHostAddresses?: readonly string[];
}): { readonly reason?: string; readonly hostIpv4?: string } {
  const { parentInterface, network, lookup, pools, samples } = input;
  if (!parentInterface) {
    return { reason: 'preflight_lan_bridge_missing' };
  }
  if (pools.length === 0) {
    return { reason: 'preflight_ip_pool_missing' };
  }
  const exporterIsBridge = network.isBridge === true
    || unlabeledOrInterfaceGauge(samples, 'nyabase_node_network_is_bridge', parentInterface) === 1;
  const parentExists = parentInterfaceExists(samples, parentInterface, network);
  if (lookup.networkMissing) {
    if (!exporterIsBridge) {
      return {
        reason: parentExists ? 'preflight_parent_not_bridge' : 'preflight_lan_bridge_missing',
      };
    }
  } else {
    if (lookup.network?.type !== 'bridge') {
      return { reason: 'preflight_parent_not_bridge' };
    }
    if (lookup.network.managed === true) {
      return { reason: 'preflight_parent_is_managed' };
    }
  }
  const incusSlaves = lookup.state?.bridge?.upper_devices ?? [];
  const exporterSlaves = Array.isArray(network.slaves)
    ? network.slaves.filter((value): value is string => typeof value === 'string')
    : [];
  const slaves = incusSlaves.length > 0 ? incusSlaves : exporterSlaves;
  if (slaves.length === 0) {
    return { reason: 'preflight_bridge_has_no_uplink' };
  }
  const ipv4Present = isRecord(network.ipv4Present) ? network.ipv4Present : {};
  for (const slave of slaves) {
    if (!(slave in ipv4Present)) {
      return { reason: 'preflight_slave_ipv4_unproven' };
    }
    if (ipv4Present[slave] !== false) {
      return { reason: 'preflight_host_ip_still_on_uplink' };
    }
  }
  if (network.nftAvailable !== true) {
    return { reason: 'preflight_nft_unavailable' };
  }
  const hostIpv4 = pickHostIpv4FromList(
    [
      ...inetGlobalAddresses(lookup.state?.addresses),
      ...(input.extraHostAddresses ?? []),
    ],
    pools,
  );
  if (!hostIpv4) {
    return { reason: 'preflight_host_ip_not_in_pool' };
  }
  return { hostIpv4 };
}

