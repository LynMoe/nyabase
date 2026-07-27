import assert from 'node:assert/strict';
import test from 'node:test';
import { sshProbeScript, validateInput as validateSshInput } from './container-ssh-client.mjs';
import {
  duplicateClaimFaultHostname,
  duplicateFaultDockerRunArgs,
  duplicateFaultIdentity,
  faultNodeCleanupMode,
  managedRuntimeInspectIsAbsent,
  manifestHasResourceIdentity,
  validateRuntimeContainerIdentitySets,
} from './fault-control.mjs';
import { validateRemoteStorageInput } from './remote-storage-contract.mjs';
import { validateStorageFixtureInput } from './storage-fixture-contract.mjs';
import { validateProxyClientInput } from './proxy-client-contract.mjs';
import {
  lifecycleHistoryPath,
  lifecycleProbeKinds,
  validateDedicatedLifecycleHistory,
} from './lifecycle-probe-contract.mjs';

const runId = 'contract-unit';
const privateKey = [
  '-----BEGIN OPENSSH PRIVATE KEY-----',
  'A'.repeat(128),
  '-----END OPENSSH PRIVATE KEY-----',
  '',
].join('\n');
const fingerprint = `SHA256:${'A'.repeat(43)}`;
const validSshInput = {
  runId,
  nodeKey: 'node1',
  containerId: '00000000-0000-4000-8000-000000000001',
  runtimeId: 'a'.repeat(64),
  expectedIp: '172.31.42.101',
  expectedHostKeyFingerprint: fingerprint,
  expectedClientKeyFingerprint: fingerprint,
  privateKey,
  marker: 'ssh-rotation.contract-unit-0001',
};
const context = {
  runId,
  state: { NYABASE_E2E_SUBNET: '172.31.42.0/24' },
};

test('SSH client accepts only the closed identity-and-marker input contract', () => {
  assert.equal(validateSshInput({ ...validSshInput }, context).marker, validSshInput.marker);

  for (const field of ['host', 'path', 'command']) {
    assert.throws(
      () => validateSshInput({ ...validSshInput, [field]: 'caller-controlled' }, context),
      /unknown or missing fields/,
    );
  }
  assert.throws(
    () => validateSshInput({ ...validSshInput, expectedIp: '172.31.42.100' }, context),
    /allocation pool/,
  );
  assert.throws(
    () => validateSshInput({ ...validSshInput, expectedIp: '172.31.43.101' }, context),
    /current product CIDR/,
  );
  assert.throws(
    () => validateSshInput({ ...validSshInput, marker: 'ok; id' }, context),
    /closed data vocabulary/,
  );
  assert.throws(
    () => validateSshInput({ ...validSshInput, privateKey: 'not-a-key' }, context),
    /private key envelope/,
  );
});

test('SSH probe script pins identities, key modes, strict host trust, and removal', () => {
  const requiredFragments = [
    'cat >"$private_key"',
    'chmod 0600 "$private_key"',
    'client_fingerprint="$2"',
    'host_fingerprint="$2"',
    '-o StrictHostKeyChecking=yes',
    '-o UserKnownHostsFile="$known_hosts"',
    '-o HostKeyAlgorithms=ssh-ed25519',
    '"root@$ip" /bin/echo "$marker"',
    '[ ! -e "$private_key" ]',
    '[ ! -e "$known_hosts" ]',
  ];
  for (const fragment of requiredFragments) {
    assert.ok(sshProbeScript.includes(fragment), `missing SSH safety fragment: ${fragment}`);
  }
  assert.doesNotMatch(sshProbeScript, /ssh .*sh -c/);
});

test('capacity runtime evidence requires sorted full IDs and active subset of all', () => {
  const first = '1'.repeat(64);
  const second = '2'.repeat(64);
  const evidence = validateRuntimeContainerIdentitySets([first, second], [second]);
  assert.deepEqual(evidence, {
    runtimeContainerIds: [first, second],
    activeRuntimeContainerIds: [second],
  });

  assert.throws(
    () => validateRuntimeContainerIdentitySets([second, first], [second]),
    /canonically sorted/,
  );
  assert.throws(
    () => validateRuntimeContainerIdentitySets([first, first], [first]),
    /duplicate Docker identities/,
  );
  assert.throws(() => validateRuntimeContainerIdentitySets([first], [second]), /not a subset/);
  assert.throws(
    () => validateRuntimeContainerIdentitySets([first.slice(1)], []),
    /invalid full Docker identity/,
  );
});

test('managed runtime inspection distinguishes exact absence from Docker unavailability', () => {
  const runtimeId = 'a'.repeat(64);
  assert.equal(
    managedRuntimeInspectIsAbsent(
      { code: 1, stdout: '', stderr: `Error: No such object: ${runtimeId}` },
      runtimeId,
    ),
    true,
  );
  assert.equal(
    managedRuntimeInspectIsAbsent(
      {
        code: 1,
        stdout: '',
        stderr: `Error response from daemon: No such container: ${runtimeId}`,
      },
      runtimeId,
    ),
    true,
  );
  assert.equal(
    managedRuntimeInspectIsAbsent(
      {
        code: 1,
        stdout: '',
        stderr:
          'Cannot connect to the Docker daemon at unix:///run/nyabase-agent/docker.sock. Is the docker daemon running?',
      },
      runtimeId,
    ),
    false,
  );
  assert.equal(
    managedRuntimeInspectIsAbsent(
      { code: 1, stdout: '', stderr: `Error: No such object: ${'b'.repeat(64)}` },
      runtimeId,
    ),
    false,
  );
});

test('duplicate-claim fault uses a bounded hostname for the longest valid run identity', () => {
  const longestRunId = `r${'0'.repeat(47)}`;
  const faultContext = {
    runId: longestRunId,
    state: {
      NYABASE_E2E_PREFIX: `nyabase-e2e-${longestRunId}`,
      NYABASE_E2E_SUBNET: '172.31.42.0/24',
      NYABASE_E2E_POSTGRES_IP: '172.31.42.14',
      NYABASE_E2E_NODE1_IP: '172.31.42.11',
      NYABASE_E2E_RATE_LIMIT_EDGE_IP: '172.31.42.13',
      NYABASE_E2E_PROBE_IP: '172.31.42.20',
      NYABASE_E2E_DUPLICATE_FAULT_IP: '172.31.42.23',
      NYABASE_E2E_NETWORK: `nyabase-e2e-${longestRunId}-cluster`,
      NYABASE_E2E_NODE_IMAGE: `nyabase-e2e-${longestRunId}-node:worktree`,
    },
  };
  const input = { serverId: '00000000-0000-4000-8000-000000000001' };
  const identity = duplicateFaultIdentity(faultContext);
  const runArgs = duplicateFaultDockerRunArgs(input, faultContext, identity);
  const hostnameIndex = runArgs.indexOf('--hostname');

  assert.ok(Buffer.byteLength(identity.containerName) > 63);
  assert.equal(identity.hostname, duplicateClaimFaultHostname);
  assert.equal(identity.outerIp, faultContext.state.NYABASE_E2E_DUPLICATE_FAULT_IP);
  assert.notEqual(identity.outerIp, faultContext.state.NYABASE_E2E_POSTGRES_IP);
  assert.notEqual(identity.outerIp, faultContext.state.NYABASE_E2E_RATE_LIMIT_EDGE_IP);
  assert.notEqual(identity.outerIp, faultContext.state.NYABASE_E2E_PROBE_IP);
  assert.ok(Buffer.byteLength(identity.hostname) <= 63);
  assert.equal(runArgs[hostnameIndex + 1], duplicateClaimFaultHostname);
  assert.notEqual(runArgs[hostnameIndex + 1], identity.containerName);
});

test('duplicate-claim restore retires only a resource identity that was recorded', () => {
  const name = 'nyabase-e2e-contract-fault-duplicate-claim';
  assert.equal(manifestHasResourceIdentity({ resources: [] }, 'container', name), false);
  assert.equal(manifestHasResourceIdentity({
    resources: [{ kind: 'container', name, active: false }],
  }, 'container', name), true);
  assert.equal(manifestHasResourceIdentity({
    resources: [{ kind: 'provider-fault', name, active: true }],
  }, 'container', name), false);
});

test('duplicate-claim cleanup discards only never-started Docker objects', () => {
  assert.equal(
    faultNodeCleanupMode({ State: { Running: false, Status: 'created' } }),
    'discard-unstarted',
  );
  assert.equal(
    faultNodeCleanupMode({ State: { Running: true, Status: 'running' } }),
    'physical',
  );
  assert.throws(
    () => faultNodeCleanupMode({ State: { Running: false, Status: 'exited' } }),
    /not running for physical cleanup/,
  );
});

test('remote storage accepts only current-run identities and fixed proof actions', () => {
  const mountId = '00000000-0000-4000-8000-000000000001';
  const base = { runId, nodeKey: 'node1', mountId, fsType: 'nfs' };
  assert.deepEqual(
    validateRemoteStorageInput({ ...base, action: 'probe' }, runId),
    { ...base, action: 'probe' },
  );
  assert.deepEqual(
    validateRemoteStorageInput({ ...base, action: 'write', marker: 'nfs.cross-node:01' }, runId),
    { ...base, action: 'write', marker: 'nfs.cross-node:01' },
  );

  for (const field of ['path', 'host', 'command', 'mountOptions', 'secret']) {
    assert.throws(
      () => validateRemoteStorageInput({ ...base, action: 'probe', [field]: 'caller' }, runId),
      /unknown or missing fields/,
    );
  }
  assert.throws(
    () => validateRemoteStorageInput({ ...base, runId: 'another', action: 'probe' }, runId),
    /run identity mismatch/,
  );
  assert.throws(
    () => validateRemoteStorageInput({ ...base, nodeKey: 'node3', action: 'probe' }, runId),
    /Invalid storage node/,
  );
  assert.throws(
    () => validateRemoteStorageInput({ ...base, mountId: 'not-a-uuid', action: 'probe' }, runId),
    /v4 UUID/,
  );
  assert.throws(
    () => validateRemoteStorageInput({ ...base, fsType: 'local', action: 'probe' }, runId),
    /Invalid remote filesystem type/,
  );
  assert.throws(
    () => validateRemoteStorageInput({ ...base, action: 'write' }, runId),
    /unknown or missing fields/,
  );
  assert.throws(
    () => validateRemoteStorageInput({ ...base, action: 'read', marker: 'bad;cat /etc/passwd' }, runId),
    /marker contract mismatch/,
  );
  for (const action of ['probe', 'holdBusy', 'releaseBusy']) {
    assert.throws(
      () => validateRemoteStorageInput({ ...base, action, marker: 'unexpected' }, runId),
      /unknown or missing fields/,
    );
  }
});

test('storage fixture failure control accepts only the current-run NFS lifecycle', () => {
  const base = { runId, fixture: 'nfs' };
  for (const action of ['stop', 'start', 'probe']) {
    assert.deepEqual(
      validateStorageFixtureInput({ ...base, action }, runId),
      { ...base, action },
    );
  }
  for (const field of ['path', 'host', 'command', 'container', 'secret']) {
    assert.throws(
      () => validateStorageFixtureInput({ ...base, action: 'probe', [field]: 'caller' }, runId),
      /unknown or missing fields/,
    );
  }
  assert.throws(
    () => validateStorageFixtureInput({ ...base, runId: 'another', action: 'probe' }, runId),
    /run identity mismatch/,
  );
  assert.throws(
    () => validateStorageFixtureInput({ ...base, fixture: 'cephfs', action: 'probe' }, runId),
    /Invalid storage fixture/,
  );
  assert.throws(
    () => validateStorageFixtureInput({ ...base, action: 'restart' }, runId),
    /Invalid storage fixture action/,
  );
});

test('proxy client accepts only fixed external SSH, SFTP, HTTP, and WebSocket actions', () => {
  assert.deepEqual(validateProxyClientInput({ runId, action: 'sshHostKey' }, runId), {
    runId,
    action: 'sshHostKey',
  });
  const ssh = {
    runId,
    action: 'sshExec',
    nodeKey: 'node1',
    containerName: 'proxy-target',
    marker: 'ssh.contract:01',
  };
  assert.deepEqual(validateProxyClientInput(ssh, runId), ssh);
  const http = {
    runId,
    action: 'websocketEcho',
    hostname: 'app.contract.test',
    marker: 'ws.contract:01',
  };
  assert.deepEqual(validateProxyClientInput(http, runId), http);

  for (const field of ['path', 'host', 'ip', 'port', 'command', 'privateKey', 'token']) {
    assert.throws(
      () => validateProxyClientInput({ ...ssh, [field]: 'caller' }, runId),
      /unknown or missing fields/,
    );
  }
  assert.throws(
    () => validateProxyClientInput({ ...ssh, runId: 'another' }, runId),
    /run identity mismatch/,
  );
  assert.throws(
    () => validateProxyClientInput({ ...ssh, nodeKey: 'node3' }, runId),
    /Invalid proxy target node/,
  );
  assert.throws(
    () => validateProxyClientInput({ ...ssh, containerName: '../target' }, runId),
    /Invalid proxy target container name/,
  );
  assert.throws(
    () => validateProxyClientInput({ ...ssh, marker: 'ok; id' }, runId),
    /Invalid proxy client marker/,
  );
  assert.throws(
    () => validateProxyClientInput({ ...http, hostname: 'http://caller' }, runId),
    /Invalid HTTP proxy hostname/,
  );
});

test('post-run lifecycle evidence is scoped to one exact public resource history', () => {
  const containerId = '00000000-0000-4000-8000-000000000001';
  assert.equal(
    lifecycleHistoryPath(containerId),
    `/admin/agent-tasks?resourceType=container&resourceId=${containerId}&limit=100`,
  );
  const tasks = lifecycleProbeKinds.map((kind, index) => ({
    id: `task-${index}`,
    kind,
    resourceId: containerId,
    status: 'succeeded',
  }));
  assert.deepEqual(validateDedicatedLifecycleHistory(tasks, containerId), tasks);

  assert.throws(
    () => validateDedicatedLifecycleHistory(tasks.slice(1), containerId),
    /exactly one successful container.create/,
  );
  assert.throws(
    () =>
      validateDedicatedLifecycleHistory(
        [...tasks, { ...tasks[0], id: 'duplicate-create' }],
        containerId,
      ),
    /exactly one successful container.create/,
  );
  assert.throws(
    () =>
      validateDedicatedLifecycleHistory(
        [
          ...tasks,
          {
            id: 'noise',
            kind: 'container.create',
            resourceId: 'another',
            status: 'succeeded',
          },
        ],
        containerId,
      ),
    /another resource identity/,
  );
});
