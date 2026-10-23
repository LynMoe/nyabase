import { beforeEach, describe, expect, it } from 'vitest';
import { AgentPolicyTunnel } from './agent-policy.test-helper.js';
import { ConsoleSessionService } from './containers/console-session.service.js';
import {
  buildContainerSpec,
  createInstance,
  deletePhysicalInstance,
  putManagedFields,
  removeDevices,
  renameInstance,
  restartWithProof,
  setPowerState,
  toSpecAttachments,
  type ContainerSpecRuntime,
} from './containers/container-instance-ops.js';
import type { ContainerAttachment, ContainerRow } from './containers/container-reconcile.store.js';
import { IncusContainerSshStateAdapter } from './containers/container-ssh.js';
import { applyGuestNetwork } from './containers/guest-network.adapter.js';
import type { AuditService } from './iam/audit.service.js';
import {
  deleteManagedImage,
  deletePreviousImageIfUnused,
  ensureAliasOnFingerprint,
  ensurePulled,
} from './images/image-assignment-ops.js';
import {
  deriveAttachmentDeviceName,
  deriveInstanceName,
  deriveVolumeName,
  IncusClient,
  subscribeIncusEvents,
} from './incus/index.js';
import type { NyabaseConfigService } from './platform/config/nyabase-config.service.js';
import type { IntentRecord } from './reconcile/intent-model.js';
import { IncusPreflightChecksAdapter } from './servers/preflight-checks.adapter.js';
import { runProbe, type ProbeRun, type ReportChecks } from './servers/server-preflight-probe.js';
import { normalized, type ServerRow } from './servers/server-preflight.store.js';
import {
  createCustomVolume,
  deleteCatalog,
  updateCustomVolume,
} from './volumes/volume-ops.js';

/*
 * The host agent's policy (packages/agent/src/policy.ts) is the boundary every
 * Incus request crosses; a body it refuses fails as a non-retrying
 * AGENT_POLICY_DENIED. These flows run the Backend's real spec builders and
 * Incus operations through its real IncusClient into the agent's real policy
 * (agent-policy.test-helper.ts), so a builder and the policy cannot drift
 * apart without failing here.
 */

const SERVER_ID = '7f1c2d3e-4b5a-4c6d-8e9f-0a1b2c3d4e5f';
const CONTAINER_ID = '0b6b2f5e-2f8f-4b64-8a8e-5f4c4c4c4c4c';
const LOCAL_VOLUME_ID = '1c2d3e4f-5a6b-4c7d-8e9f-001122334455';
const SHARED_VOLUME_ID = '2d3e4f5a-6b7c-4d8e-9fa0-112233445566';
const LATE_VOLUME_ID = '3e4f5a6b-7c8d-4e9f-a0b1-223344556677';
const ATTACHMENT_IDS = [
  '4f5a6b7c-8d9e-4fa0-b1c2-334455667788',
  '5a6b7c8d-9eaf-4b01-82d3-445566778899',
  '6b7c8d9e-afb0-4c12-93e4-5566778899aa',
] as const;
const FINGERPRINT = 'c'.repeat(64);
const IMAGE_SERVER = 'https://images.nyabase.example';

const RUNTIME: ContainerSpecRuntime = {
  cpus: [2, 3, 6, 7],
  limits: {
    processes: 4096,
    networkIngressMbit: 1000,
    networkEgressMbit: 500,
    diskReadMBps: 200,
    diskWriteMBps: 100,
  },
};

function containerRow(overrides: Partial<ContainerRow> = {}): ContainerRow {
  return {
    id: CONTAINER_ID,
    server_id: SERVER_ID,
    owner_id: '8d9eafb0-c1d2-4e3f-a4b5-66778899aabb',
    name: 'dev',
    image_id: '9eafb0c1-d2e3-4f40-b5c6-778899aabbcc',
    revision: 3,
    image_fingerprint: FINGERPRINT,
    root_size_bytes: '10737418240',
    mem_bytes: '4294967296',
    cpu_set: [2, 3, 6, 7],
    gpu_enabled: true,
    gpu_state: { nvidiaRuntime: true, pciAddresses: ['0000:41:00.0', '0000:81:00.0'] },
    nesting: true,
    syscall_intercept: true,
    power_intent: 'running',
    lifecycle_phase: 'active',
    root_pool_name: 'default',
    root_resize_family: 'quota_online',
    parent_interface: 'vmbr0',
    routed_ip: '10.20.0.15',
    network_key: 'lan',
    gateway: '10.20.0.1',
    dns_servers: ['10.20.0.1'],
    login_user: 'dev',
    ssh_public_key: null,
    ...overrides,
  };
}

function attachment(
  index: number,
  volumeId: string,
  options: { readonly shared: boolean; readonly readOnly: boolean; readonly path: string },
): ContainerAttachment {
  return {
    id: ATTACHMENT_IDS[index]!,
    container_path: options.path,
    read_only: options.readOnly,
    volume_id: volumeId,
    incus_name: deriveVolumeName(volumeId),
    pool_name: options.shared ? 'cephfs' : 'default',
    size_bytes: '21474836480',
    shared: options.shared,
    shared_backend_id: options.shared ? 'b0c1d2e3-f4a5-4b6c-8d7e-8899aabbccdd' : null,
    bind_state: 'attached',
  };
}

const intent = {
  id: 'c1d2e3f4-a5b6-4c7d-8e9f-99aabbccddee',
  resourceType: 'image_assignment',
  resourceId: 'd2e3f4a5-b6c7-4d8e-9fa0-aabbccddeeff',
  requestedBy: null,
} as unknown as IntentRecord;
const audit = { log: async () => undefined } as unknown as AuditService;

let tunnel: AgentPolicyTunnel;
let client: IncusClient;

beforeEach(async () => {
  tunnel = await AgentPolicyTunnel.create();
  client = new IncusClient({ tunnel });
});

describe('the agent policy accepts what the Backend sends', () => {
  it('through a container lifecycle: create with GPUs and volumes, power, hot attach / detach, drift, delete', async () => {
    const name = deriveInstanceName(CONTAINER_ID);
    const local = attachment(0, LOCAL_VOLUME_ID, { shared: false, readOnly: false, path: '/data' });
    const shared = attachment(1, SHARED_VOLUME_ID, { shared: true, readOnly: true, path: '/mnt/team' });
    const late = attachment(2, LATE_VOLUME_ID, { shared: false, readOnly: false, path: '/scratch' });
    const desired = buildContainerSpec(containerRow(), toSpecAttachments([local, shared]), RUNTIME);

    await createInstance(client, desired, name);
    await applyGuestNetwork(client, name, {
      address: '10.20.0.15',
      prefixLength: 24,
      gateway: '10.20.0.1',
      dnsServers: ['10.20.0.1'],
    });
    await setPowerState(client, name, 'start');

    // Hot attach and a limits change on the running instance (a NIC change while up).
    const grown = buildContainerSpec(
      containerRow({ revision: 4, mem_bytes: '8589934592' }),
      toSpecAttachments([local, shared, late]),
      { ...RUNTIME, limits: { ...RUNTIME.limits, networkIngressMbit: 2000 } },
    );
    await putManagedFields(client, name, grown, true);
    await removeDevices(client, name, [deriveAttachmentDeviceName(ATTACHMENT_IDS[1])]);

    // Host-side drift (an unknown key, a foreign device) is overwritten with the managed document.
    const drifted = tunnel.host.instances.get(name)!;
    drifted.config = { ...(drifted.config as object), 'raw.lxc': 'lxc.apparmor.profile=unconfined' };
    drifted.devices = { ...(drifted.devices as object), web: { type: 'proxy', listen: 'tcp:0.0.0.0:80' } };
    await putManagedFields(client, name, grown, true);

    await restartWithProof(client, name, null);
    await setPowerState(client, name, 'stop');
    const renamed = deriveInstanceName('e3f4a5b6-c7d8-4e9f-a0b1-bbccddeeff00');
    await renameInstance(client, name, renamed);
    await deletePhysicalInstance(client, renamed);

    expect(tunnel.refusals).toEqual([]);
    expect(tunnel.mutations).toEqual(expect.arrayContaining([
      'POST /1.0/instances',
      `POST /1.0/instances/${name}/exec`,
      `PUT /1.0/instances/${name}/state`,
      `PUT /1.0/instances/${name}`,
      `POST /1.0/instances/${name}`,
      `DELETE /1.0/instances/${renamed}`,
    ]));
  });

  it('for a container without GPU, attachments or nesting', async () => {
    const name = deriveInstanceName(CONTAINER_ID);
    const desired = buildContainerSpec(
      containerRow({ gpu_enabled: false, gpu_state: null, nesting: false, syscall_intercept: false, cpu_set: [0] }),
      [],
      { ...RUNTIME, cpus: [0] },
    );
    await createInstance(client, desired, name);
    await setPowerState(client, name, 'start');
    expect(tunnel.refusals).toEqual([]);
  });

  it('for guest files, scripts, consoles and event streams', async () => {
    const name = deriveInstanceName(CONTAINER_ID);
    await createInstance(client, buildContainerSpec(containerRow(), [], RUNTIME), name);
    const ssh = new IncusContainerSshStateAdapter();
    await ssh.writeAuthorizedKeys(client, name, '/home/dev/.ssh/authorized_keys', 'ssh-ed25519 AAAA dev', { uid: 1000, gid: 1000 });
    await ssh.writeRootFile(client, name, '/etc/ssh/sshd_config.d/50-nyabase.conf', 'HostCertificate /etc/ssh/x\n');
    await ssh.runScript(client, name, ['/bin/sh', '-c', 'systemctl reload ssh']);
    const consoles = new ConsoleSessionService(undefined as never, undefined as never, undefined as never);
    const tty = await consoles.openExec(client, name, ['/bin/bash', '-l'], { user: 1000, group: 1000, width: 120, height: 40 });
    tty.close();
    const pipes = await consoles.openExec(client, name, ['/usr/bin/env'], { tty: false });
    pipes.close();
    const events = subscribeIncusEvents(client);
    await expect.poll(() => tunnel.forwarded).toContain('WS /1.0/events');
    events.close();
    expect(tunnel.refusals).toEqual([]);
  });

  it('for local and shared volumes: create, resize, delete', async () => {
    for (const [pool, scope] of [['default', SERVER_ID], ['cephfs', 'b0c1d2e3-f4a5-4b6c-8d7e-8899aabbccdd']] as const) {
      const incusName = deriveVolumeName(LOCAL_VOLUME_ID);
      const created = await createCustomVolume(client, pool, incusName, '21474836480', scope);
      expect(created).toBeDefined();
      await updateCustomVolume(client, pool, incusName, created!, { ...created!.config }, 42949672960n);
      await deleteCatalog(client, pool, incusName);
    }
    expect(tunnel.refusals).toEqual([]);
    expect(tunnel.mutations).toEqual(expect.arrayContaining([
      'POST /1.0/storage-pools/default/volumes',
      `PUT /1.0/storage-pools/cephfs/volumes/custom/${deriveVolumeName(LOCAL_VOLUME_ID)}`,
    ]));
  });

  it('for image pulls, aliases and cleanup', async () => {
    const pulls = new Map<string, Promise<void>>();
    await ensurePulled(audit, pulls, client, {
      alias: 'debian/12',
      fingerprint: FINGERPRINT,
      sourceServer: IMAGE_SERVER,
    }, SERVER_ID, intent);
    await ensurePulled(audit, pulls, client, {
      alias: 'ubuntu/24.04',
      fingerprint: null,
      sourceServer: IMAGE_SERVER,
      imageType: 'container',
    }, SERVER_ID, intent);
    const images = (await client.listImages(1)).metadata;
    await ensureAliasOnFingerprint(audit, client, images, 'nyabase/debian-12', FINGERPRINT, intent);
    const other = images.find((image) => image.fingerprint !== FINGERPRINT)!.fingerprint!;
    await deletePreviousImageIfUnused(audit, client, other, FINGERPRINT, intent);
    await deleteManagedImage(audit, client, FINGERPRINT, intent);
    expect(tunnel.refusals).toEqual([]);
    expect(tunnel.mutations).toEqual(expect.arrayContaining([
      'POST /1.0/images',
      'POST /1.0/images/aliases',
      `DELETE /1.0/images/${FINGERPRINT}`,
    ]));
  });

  it('for the preflight probe of a new server', async () => {
    const server: ServerRow = {
      id: SERVER_ID,
      name: 'worker-1',
      parent_interface: 'vmbr0',
      dns_servers: ['10.20.0.1'],
      status: 'online',
      system_pool_id: null,
      preflight_status: 'running',
      gpu_enabled: false,
      revision: 1,
    };
    const config = {
      get: (key: string) => ({
        'incus.preflightEgressUrl': 'https://example.com/',
        'incus.operationWaitTimeoutMs': 30_000,
      } as Record<string, unknown>)[key],
    } as unknown as NyabaseConfigService;
    const gauge = (name: string, labels: Record<string, string> = {}) => ({ name, labels, value: 1 });
    const checks = {} as ReportChecks;
    for (const probeOptions of [
      { probeImageAlias: 'debian/12', probeImageFingerprint: '', sourceServer: IMAGE_SERVER },
      { probeImageAlias: '', probeImageFingerprint: FINGERPRINT },
    ]) {
      const run: ProbeRun = {
        client,
        server,
        signal: new AbortController().signal,
        probeName: `nyabase-preflight-${normalized(server.id)}`,
        options: { ...probeOptions, probePoolName: 'default', probeAddress: '10.20.0.250' },
        parentInterface: 'vmbr0',
        poolNetwork: { gateway: '10.20.0.1', cidr: '10.20.0.0/24', prefixLength: 24 },
        hostIpv4: '10.20.0.2',
        checks,
        adapter: new IncusPreflightChecksAdapter(undefined as never, config),
        secondMetricsPull: async () => ({
          report: {
            samples: [
              gauge('nyabase_node_ipv6_guard_present'),
              gauge('nyabase_node_network_nft_available'),
              gauge('nyabase_node_network_bridge_filter_address', { address: '10.20.0.250' }),
            ],
          },
        }),
        created: false,
      };
      await expect(runProbe(run)).resolves.toBeUndefined();
    }
    expect(tunnel.refusals).toEqual([]);
    expect(checks).toMatchObject({ guestCanReachHost: 'pass', egress: 'pass' });
    expect(tunnel.host.instances.size).toBe(0);
  });
});
