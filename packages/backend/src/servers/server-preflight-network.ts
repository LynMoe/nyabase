import { isIP } from 'node:net';
import { isUsableHostInCidr, type NodeMetricSample } from '@nyabase/common';
import { IncusError, type IncusClientPort, type IncusSchema } from '../incus/index.js';
import type { IpPoolNetwork, ParentNetworkLookup } from './server-preflight-support.js';
import { isRecord } from './server-preflight-support.js';

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

