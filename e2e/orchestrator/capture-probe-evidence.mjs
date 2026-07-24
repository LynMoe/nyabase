#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  aggregateErrorWithDiagnostics,
  runEntrypointWithDiagnostics,
} from '../support/error-diagnostics.mjs';
import {
  lifecycleHistoryPath,
  validateDedicatedLifecycleHistory,
} from './lifecycle-probe-contract.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

async function main() {
  const runtimeDir = resolve(process.argv[2] ?? '');
  if (!process.argv[2]) {
    throw new Error('usage: capture-probe-evidence.mjs <runtimeDir>');
  }

  const parseEnv = (text) =>
    Object.fromEntries(
      text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf('=');
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );

  const { state } = await loadValidatedRunState(runtimeDir);
  const secrets = parseEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
  const seed = JSON.parse(await readFile(join(runtimeDir, 'seed.json'), 'utf8'));
  const reportPath = join(runtimeDir, 'reports', 'playwright.json');
  const reportBytes = await readFile(reportPath);
  const runId = state.NYABASE_E2E_RUN_ID;
  const apiBase = `${state.NYABASE_E2E_PUBLIC_URL}/api`;
  const asyncReconciliationQuietMs = 12_000;

  async function requestJson(method, path, token, body, expectedStatuses = [200]) {
    const response = await fetch(`${apiBase}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!expectedStatuses.includes(response.status)) {
      throw new Error(`${method} ${path} returned ${response.status}; response body withheld`);
    }
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new Error(`${method} ${path} returned invalid JSON; response body withheld`);
    }
  }

  const delay = (milliseconds) =>
    new Promise((resolveDelay) => {
      setTimeout(resolveDelay, milliseconds);
    });

  function remaining(deadline, description) {
    const milliseconds = deadline - Date.now();
    if (milliseconds <= 0) throw new Error(`${description} exceeded its absolute deadline`);
    return milliseconds;
  }

  async function waitForTask(taskId, kind, resourceId, token, deadline) {
    while (true) {
      remaining(deadline, `${kind} task ${taskId}`);
      const task = await requestJson('GET', `/admin/agent-tasks/${taskId}`, token);
      if (task?.id !== taskId || task?.kind !== kind || task?.resourceId !== resourceId) {
        throw new Error(`${kind} task ${taskId} returned inconsistent public identity`);
      }
      if (task.status === 'succeeded') return task;
      if (task.status === 'failed') {
        throw new Error(`${kind} task ${taskId} failed; response body withheld`);
      }
      if (task.status !== 'pending') {
        throw new Error(`${kind} task ${taskId} returned unknown status`);
      }
      await delay(Math.min(500, remaining(deadline, `${kind} task ${taskId}`)));
    }
  }

  async function getContainer(containerId, token) {
    const response = await fetch(`${apiBase}/v2/containers/${containerId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(
        `GET /v2/containers/${containerId} returned ${response.status}; response body withheld`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error(
        `GET /v2/containers/${containerId} returned invalid JSON; response body withheld`,
      );
    }
  }

  async function waitForContainer(containerId, token, description, accept, deadline) {
    while (true) {
      remaining(deadline, description);
      const container = await getContainer(containerId, token);
      if (accept(container)) return container;
      await delay(Math.min(500, remaining(deadline, description)));
    }
  }

  async function waitForQuiescentRunningContainer(containerId, token, deadline) {
    let stableSince = null;
    let stableTaskFingerprint = null;
    while (true) {
      remaining(deadline, `task-quiet running container ${containerId}`);
      const [container, tasks] = await Promise.all([
        getContainer(containerId, token),
        requestJson('GET', lifecycleHistoryPath(containerId), token),
      ]);
      const taskFingerprint = JSON.stringify(
        tasks
          .map(({ id, kind, status, completedAt }) => ({ id, kind, status, completedAt }))
          .sort((left, right) => left.id.localeCompare(right.id)),
      );
      const converged =
        container !== null &&
        container.runtime?.status === 'running' &&
        container.powerIntent === 'running' &&
        container.activeTask === null &&
        (container.failureCode ?? null) === null &&
        container.ssh?.enabled === false &&
        container.ssh?.status === 'disabled' &&
        typeof container.ssh?.observedAt === 'string' &&
        !Number.isNaN(Date.parse(container.ssh.observedAt)) &&
        tasks.length > 0 &&
        tasks.every((task) => task.status === 'succeeded');
      if (converged) {
        if (taskFingerprint !== stableTaskFingerprint) {
          stableTaskFingerprint = taskFingerprint;
          stableSince = Date.now();
        } else if (stableSince !== null && Date.now() - stableSince >= asyncReconciliationQuietMs) {
          return container;
        }
      } else {
        stableTaskFingerprint = null;
        stableSince = null;
      }
      await delay(
        Math.min(500, remaining(deadline, `task-quiet running container ${containerId}`)),
      );
    }
  }

  async function settleAction(containerId, action, token, deadline) {
    const kind = `container.${action}`;
    const taskRef = await requestJson(
      'POST',
      `/v2/containers/${containerId}/actions/${action}`,
      token,
      undefined,
      [201],
    );
    if (typeof taskRef?.taskId !== 'string' || taskRef.taskId.length === 0) {
      throw new Error(`${kind} response omitted its task ID`);
    }
    return waitForTask(taskRef.taskId, kind, containerId, token, deadline);
  }

  async function cleanupProbeContainer(containerId, token) {
    const deadline = Date.now() + 240_000;
    const container = await waitForContainer(
      containerId,
      token,
      `cleanup availability for ${containerId}`,
      (candidate) =>
        candidate === null ||
        (candidate.activeTask === null && candidate.actions?.delete?.enabled === true),
      deadline,
    );
    if (container === null) return;
    await settleAction(containerId, 'delete', token, deadline);
    await waitForContainer(
      containerId,
      token,
      `cleanup absence for ${containerId}`,
      (candidate) => candidate === null,
      deadline,
    );
  }

  function docker(args, { allowFailure = false } = {}) {
    const result = spawnSync('docker', args, { encoding: 'utf8' });
    if (!allowFailure && result.status !== 0) {
      throw new Error(`docker ${args[0] ?? ''} failed with status ${String(result.status)}`);
    }
    return result;
  }

  function nodeDocker(nodeKey, args, options) {
    return docker(
      [
        'exec',
        `nyabase-e2e-${runId}-${nodeKey}`,
        '/usr/bin/docker',
        '--host',
        'unix:///run/nyabase-agent/docker.sock',
        ...args,
      ],
      options,
    );
  }

  const login = await requestJson('POST', '/auth/login', undefined, {
    username: 'admin',
    password: secrets.ADMIN_INIT_PASSWORD,
  });
  if (!login?.accessToken) throw new Error('admin login response omitted its access token');
  const token = login.accessToken;
  const serverId = seed.servers?.find((server) => server.key === 'node1')?.serverId;
  if (typeof serverId !== 'string' || serverId.length === 0) {
    throw new Error('seed evidence omitted node1 server identity');
  }
  if (typeof seed.image?.id !== 'string' || seed.image.id.length === 0) {
    throw new Error('seed evidence omitted workload image identity');
  }

  const lifecycleDeadline = Date.now() + 300_000;
  const probeName = `${runId
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .slice(0, 32)}-post-run-${Date.now().toString(36)}`.slice(0, 64);
  const selectedTasks = [];
  let containerId = null;
  let runtimeId = null;
  try {
    const createRef = await requestJson(
      'POST',
      '/v2/containers',
      token,
      { serverId, imageId: seed.image.id, name: probeName },
      [201],
    );
    if (typeof createRef?.taskId !== 'string' || createRef.taskId.length === 0) {
      throw new Error('container.create response omitted its task ID');
    }
    const pendingCreate = await requestJson('GET', `/admin/agent-tasks/${createRef.taskId}`, token);
    containerId = pendingCreate?.resourceId;
    if (typeof containerId !== 'string' || containerId.length === 0) {
      throw new Error('container.create task omitted its resource identity');
    }

    const createTask = await waitForTask(
      createRef.taskId,
      'container.create',
      containerId,
      token,
      lifecycleDeadline,
    );
    selectedTasks.push(createTask);
    runtimeId = createTask.result?.runtimeId;
    if (typeof runtimeId !== 'string' || runtimeId.length !== 64) {
      throw new Error('successful container.create task omitted its physical runtime ID');
    }
    await waitForQuiescentRunningContainer(containerId, token, lifecycleDeadline);

    selectedTasks.push(await settleAction(containerId, 'stop', token, lifecycleDeadline));
    await waitForContainer(
      containerId,
      token,
      `stopped probe container ${containerId}`,
      (container) =>
        container !== null &&
        container.runtime?.status === 'exited' &&
        container.powerIntent === 'stopped' &&
        container.activeTask === null,
      lifecycleDeadline,
    );

    selectedTasks.push(await settleAction(containerId, 'start', token, lifecycleDeadline));
    await waitForQuiescentRunningContainer(containerId, token, lifecycleDeadline);

    selectedTasks.push(await settleAction(containerId, 'restart', token, lifecycleDeadline));
    await waitForQuiescentRunningContainer(containerId, token, lifecycleDeadline);

    selectedTasks.push(await settleAction(containerId, 'delete', token, lifecycleDeadline));
    await waitForContainer(
      containerId,
      token,
      `deleted probe container ${containerId}`,
      (container) => container === null,
      lifecycleDeadline,
    );
  } catch (error) {
    if (!containerId) throw error;
    try {
      await cleanupProbeContainer(containerId, token);
    } catch (cleanupError) {
      throw aggregateErrorWithDiagnostics(
        `post-run lifecycle probe and product cleanup both failed for ${containerId}`,
        [error, cleanupError],
      );
    }
    throw error;
  }

  const lifecycleTasks = await requestJson('GET', lifecycleHistoryPath(containerId), token);
  validateDedicatedLifecycleHistory(lifecycleTasks, containerId);

  const createTask = selectedTasks[0];
  if (typeof runtimeId !== 'string' || runtimeId.length !== 64) {
    throw new Error('successful container.create task omitted its physical runtime ID');
  }

  const controlPlane = await fetch(`${apiBase}/v2/containers/${containerId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (controlPlane.status !== 404) {
    throw new Error(
      `deleted container remains in the control plane with status ${controlPlane.status}`,
    );
  }

  const nodes = [];
  for (const nodeKey of ['node1', 'node2']) {
    const managed = nodeDocker(nodeKey, ['ps', '-aq', '--filter', 'label=nyabase.managed=true'])
      .stdout.trim()
      .split(/\s+/)
      .filter(Boolean);
    if (managed.length > 0) {
      throw new Error(`${nodeKey} retains ${managed.length} managed runtime(s)`);
    }
    const deletedRuntime = nodeDocker(nodeKey, ['inspect', runtimeId], { allowFailure: true });
    if (deletedRuntime.status === 0) {
      throw new Error(`${nodeKey} still contains deleted runtime ${runtimeId}`);
    }
    const image = nodeDocker(nodeKey, [
      'image',
      'inspect',
      seed.image.sourceImageId,
      '--format',
      '{{.Id}}|{{json .RepoDigests}}',
    ]).stdout.trim();
    const [imageId, repoDigestsJson = '[]'] = image.split('|');
    const repoDigests = JSON.parse(repoDigestsJson);
    if (imageId !== seed.image.sourceImageId || !repoDigests.includes(seed.image.registryDigest)) {
      throw new Error(`${nodeKey} workload image identity does not match seed evidence`);
    }
    nodes.push({
      nodeKey,
      managedContainerCount: managed.length,
      deletedRuntimeAbsent: true,
      workloadImageId: imageId,
      workloadRegistryDigest: seed.image.registryDigest,
    });
  }

  const evidence = {
    schemaVersion: 1,
    runId,
    capturedAt: new Date().toISOString(),
    playwright: {
      status: 'passed',
      reportPath,
      reportSha256: createHash('sha256').update(reportBytes).digest('hex'),
    },
    productLifecycle: {
      containerId,
      runtimeId,
      serverId: createTask.serverId,
      controlPlaneAbsent: true,
      tasks: selectedTasks.map((task) => ({
        id: task.id,
        kind: task.kind,
        status: task.status,
        completedAt: task.completedAt,
      })),
    },
    physical: { nodes },
  };

  const outputPath = join(runtimeDir, 'probe-evidence.json');
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(outputPath, 0o600);
  console.log(
    `probe evidence PASS: ${containerId} is absent from the control plane and both managed dockerd instances`,
  );
}

await runEntrypointWithDiagnostics(main);
