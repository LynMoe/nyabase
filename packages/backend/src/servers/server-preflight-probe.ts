import {
  IncusError,
  deriveInstanceHwaddr,
  isOperationWaitNotFound,
  readAfterTimeout,
  requestAndWait,
  type IncusClientPort,
  type IncusSchema,
} from '../incus/index.js';
import { applyGuestNetwork } from '../containers/guest-network.adapter.js';
import { labeledGauge, metricSamplesFrom, unlabeledGauge } from './server-preflight-network.js';
import type { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';
import {
  MANAGED_PROBE_KEY,
  PREFLIGHT_PROBE_MEMORY,
  PROBE_SERVER_KEY,
  normalized,
  probeHardwareId,
  type IpPoolNetwork,
  type PreflightOptions,
  type ReportChecks,
  type ServerRow,
} from './server-preflight-support.js';

type InstanceFull = IncusSchema<'InstanceFull'>;
type Metrics = { readonly report?: Record<string, unknown> };

/** Everything one probe run needs. `created` is set once the probe instance exists. */
export interface ProbeRun {
  readonly client: IncusClientPort;
  readonly server: ServerRow;
  readonly signal: AbortSignal;
  readonly probeName: string;
  readonly options: PreflightOptions;
  readonly parentInterface: string;
  readonly poolNetwork: IpPoolNetwork;
  readonly hostIpv4: string;
  readonly checks: ReportChecks;
  readonly adapter: IncusPreflightChecksAdapter;
  readonly secondMetricsPull: () => Promise<Metrics>;
  created: boolean;
}

function errorIsNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

export async function stopAndDeleteProbe(
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
    if (errorIsNotFound(error)) return;
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
        if (errorIsNotFound(error)) return undefined;
        throw error;
      }
      throw new Error('preflight probe still exists');
    },
  );
  try {
    await client.getInstanceFull(probeName, { signal });
  } catch (error) {
    if (errorIsNotFound(error)) return;
    throw error;
  }
  throw new IncusError('PREFLIGHT_CLEANUP_FAILED', 'managed_failure', {
    probeName,
    reason: 'probe_still_present',
  });
}

/** Remove a probe left behind by an earlier run, but never one we do not own. */
export async function cleanupStaleProbe(
  client: IncusClientPort,
  probeName: string,
  serverId: string,
  signal: AbortSignal,
): Promise<void> {
  let existing: InstanceFull;
  try {
    existing = (await client.getInstanceFull(probeName, { signal })).metadata;
  } catch (error) {
    if (errorIsNotFound(error)) return;
    throw error;
  }
  const config = existing.config ?? {};
  if (config[MANAGED_PROBE_KEY] !== 'true' || config[PROBE_SERVER_KEY] !== normalized(serverId)) {
    throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
      probeName,
    });
  }
  await stopAndDeleteProbe(client, probeName, signal);
}

async function confirmProbeIdentity(run: ProbeRun): Promise<InstanceFull> {
  const probe = (await run.client.getInstanceFull(run.probeName, { signal: run.signal })).metadata;
  if (
    probe.config?.[MANAGED_PROBE_KEY] !== 'true' ||
    probe.config?.[PROBE_SERVER_KEY] !== normalized(run.server.id)
  ) {
    throw new IncusError('PREFLIGHT_IDENTITY_MISMATCH', 'managed_failure', {
      probeName: run.probeName,
    });
  }
  return probe;
}

async function confirmProbeRunning(run: ProbeRun): Promise<InstanceFull> {
  const probe = await confirmProbeIdentity(run);
  // create then start is async: identity can appear while status is still Stopped.
  // Confirm Running before egress/cleanup or cleanup skips stop and DELETE 400s.
  const liveStatus = (probe.state?.status ?? probe.status ?? '').toLowerCase();
  if (liveStatus !== 'running') {
    throw new Error(`preflight probe not running yet (${liveStatus || 'unknown'})`);
  }
  return probe;
}

function createProbe(run: ProbeRun) {
  const { client, options, signal } = run;
  return requestAndWait(
    client,
    (requestOptions) =>
      client.createInstance(
        {
          name: run.probeName,
          type: 'container',
          profiles: [],
          source: {
            type: 'image',
            ...(options.probeImageFingerprint
              ? { fingerprint: options.probeImageFingerprint }
              : {
                alias: options.probeImageAlias,
                server: options.sourceServer,
                protocol: options.sourceServer ? 'simplestreams' : undefined,
              }),
          },
          config: {
            [MANAGED_PROBE_KEY]: 'true',
            [PROBE_SERVER_KEY]: normalized(run.server.id),
            // Debian+wget TLS can SIGKILL (rc 137) under tight/default pressure.
            'limits.memory': PREFLIGHT_PROBE_MEMORY,
            'security.privileged': 'false',
          },
          devices: {
            root: {
              type: 'disk',
              path: '/',
              pool: options.probePoolName,
              size: '1073741824',
            },
            eth0: {
              type: 'nic',
              nictype: 'bridged',
              name: 'eth0',
              parent: run.parentInterface,
              hwaddr: deriveInstanceHwaddr(probeHardwareId(run.server.id)),
              'ipv4.address': options.probeAddress,
              'security.ipv4_filtering': 'true',
              'security.mac_filtering': 'true',
            },
          },
          start: false,
        },
        { ...requestOptions, signal },
      ),
    { signal },
  );
}

/** Create the probe instance and start it; returns the confirmed running instance. */
async function createAndStartProbe(run: ProbeRun): Promise<InstanceFull> {
  const { client, signal } = run;
  let confirmedProbe: InstanceFull | undefined;
  try {
    await readAfterTimeout(() => createProbe(run), async () => {
      await confirmProbeIdentity(run);
      return undefined;
    });
  } catch (error) {
    if (!isOperationWaitNotFound(error)) throw error;
    await confirmProbeIdentity(run);
  }
  run.created = true;
  const confirmRunning = async (): Promise<InstanceFull> => {
    confirmedProbe = await confirmProbeRunning(run);
    return confirmedProbe;
  };
  try {
    await readAfterTimeout(
      () =>
        requestAndWait(
          client,
          (requestOptions) =>
            client.updateInstanceState(
              run.probeName,
              { action: 'start', force: false },
              { ...requestOptions, signal },
            ),
          { signal },
        ),
      async () => {
        await confirmRunning();
        return undefined;
      },
    );
  } catch (error) {
    if (!isOperationWaitNotFound(error)) throw error;
    await confirmRunning();
  }
  return confirmedProbe ?? (await client.getInstanceFull(run.probeName, { signal })).metadata;
}

/** Give the probe its platform address and run the network checks against it. */
async function verifyProbe(run: ProbeRun, probe: InstanceFull): Promise<void> {
  const { client, server, signal, options, checks } = run;
  checks.simplestreamsImage = 'pass';
  const probeDns = (server.dns_servers ?? []).filter((value) => value.trim().length > 0);
  await applyGuestNetwork(
    client,
    run.probeName,
    {
      address: options.probeAddress,
      prefixLength: run.poolNetwork.prefixLength,
      gateway: run.poolNetwork.gateway,
      dnsServers: probeDns.length > 0 ? probeDns : [run.poolNetwork.gateway],
    },
    signal,
  );
  checks.guestAddress =
    probe.config?.[PROBE_SERVER_KEY] === normalized(server.id) ? 'pass' : 'fail';
  const secondSamples = metricSamplesFrom((await run.secondMetricsPull()).report);
  if (unlabeledGauge(secondSamples, 'nyabase_node_network_nft_available') !== 1) {
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'preflight_nft_unavailable',
      serverId: server.id,
    });
  }
  checks.nftables = 'pass';
  if (
    labeledGauge(secondSamples, 'nyabase_node_network_bridge_filter_address', {
      address: options.probeAddress,
    }) !== 1
  ) {
    throw new IncusError('PREFLIGHT_FAILED', 'managed_failure', {
      reason: 'preflight_ipv4_filter_not_applied',
      serverId: server.id,
      probeAddress: options.probeAddress,
    });
  }
  checks.ipv4Filtering = 'pass';
  const reach = await run.adapter.checkGuestCanReachHost(
    server.id,
    client,
    run.probeName,
    run.hostIpv4,
    signal,
  );
  if (reach.status === 'pass') checks.guestCanReachHost = 'pass';
  const egress = await run.adapter.checkEgress(server.id, client, run.probeName, signal);
  if (egress.status === 'pass') checks.egress = 'pass';
}

/**
 * Create a throwaway probe container, run the network checks from inside it
 * and always try to remove it. Returns the cleanup error, if any; a check
 * error propagates after the cleanup attempt.
 */
export async function runProbe(run: ProbeRun): Promise<unknown> {
  await cleanupStaleProbe(run.client, run.probeName, run.server.id, run.signal);
  let cleanupError: unknown;
  try {
    const probe = await createAndStartProbe(run);
    await verifyProbe(run, probe);
  } finally {
    if (run.created) {
      try {
        await stopAndDeleteProbe(run.client, run.probeName, run.signal);
      } catch (error) {
        cleanupError = error;
      }
    }
  }
  return cleanupError;
}
