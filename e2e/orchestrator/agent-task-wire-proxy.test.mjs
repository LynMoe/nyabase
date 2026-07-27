import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWireProxyEvidence,
  observeBackendWireFrame,
  transformAgentWireFrame,
  validateWireProxyConfig,
} from './agent-task-wire-proxy.mjs';

const config = validateWireProxyConfig({
  version: 1,
  runId: 'wire-test',
  nodeKey: 'node1',
  mode: 'drop-terminal-once',
  taskId: '019b1234-1234-7123-8123-123456789abc',
  payloadHash: 'a'.repeat(64),
  gatewayIp: '172.29.42.18',
  listenPort: 18443,
});

function envelope(kind, payload) {
  return JSON.stringify({ kind, ts: 1, payload });
}

test('counts only the exact image execute identity', () => {
  const initial = createWireProxyEvidence(config);
  const exact = envelope('task.execute.v1', {
    taskId: config.taskId,
    payloadHash: config.payloadHash,
    kind: 'image.ensure_present',
    payload: { dockerRef: 'registry:5000/example/image:tag' },
  });
  const observed = observeBackendWireFrame(
    exact,
    config,
    initial,
    new Date('2026-07-17T00:00:00.000Z'),
  );
  assert.equal(observed.matchingExecute, true);
  assert.equal(observed.evidence.executeCount, 1);
  assert.equal(observed.evidence.firstExecuteAt, '2026-07-17T00:00:00.000Z');

  const wrongHash = exact.replace(config.payloadHash, 'b'.repeat(64));
  assert.deepEqual(observeBackendWireFrame(wrongHash, config, observed.evidence), {
    matchingExecute: false,
    evidence: observed.evidence,
  });
  const wrongKind = exact.replace('image.ensure_present', 'image.ensure_absent');
  assert.deepEqual(observeBackendWireFrame(wrongKind, config, observed.evidence), {
    matchingExecute: false,
    evidence: observed.evidence,
  });
});

test('drops exactly one matching terminal and passes it only after release', () => {
  const initial = observeBackendWireFrame(
    envelope('task.execute.v1', {
      taskId: config.taskId,
      payloadHash: config.payloadHash,
      kind: 'image.ensure_present',
      payload: {},
    }),
    config,
    createWireProxyEvidence(config),
  ).evidence;
  const terminal = envelope('task.result.v1', {
    taskId: config.taskId,
    payloadHash: config.payloadHash,
    status: 'succeeded',
    result: { dockerRef: 'registry:5000/example/image:tag', dockerId: 'sha256:abc' },
  });
  const dropped = transformAgentWireFrame(terminal, config, initial, {
    released: false,
    now: new Date('2026-07-17T00:00:01.000Z'),
  });
  assert.equal(dropped.action, 'drop-and-cut');
  assert.equal(dropped.text, null);
  assert.equal(dropped.evidence.droppedCount, 1);
  assert.equal(dropped.evidence.forwardedTerminalCount, 0);

  const forwarded = transformAgentWireFrame(terminal, config, dropped.evidence, {
    released: true,
    now: new Date('2026-07-17T00:00:02.000Z'),
  });
  assert.equal(forwarded.action, 'forward');
  assert.equal(forwarded.text, terminal);
  assert.equal(forwarded.evidence.droppedCount, 1);
  assert.equal(forwarded.evidence.forwardedTerminalCount, 1);
});

test('holds matching terminals without cutting the Agent connection until release', () => {
  const holdConfig = { ...config, mode: 'hold-terminal-until-release' };
  const initial = observeBackendWireFrame(
    envelope('task.execute.v1', {
      taskId: holdConfig.taskId,
      payloadHash: holdConfig.payloadHash,
      kind: 'image.ensure_present',
      payload: {},
    }),
    holdConfig,
    createWireProxyEvidence(holdConfig),
  ).evidence;
  const terminal = envelope('task.result.v1', {
    taskId: holdConfig.taskId,
    payloadHash: holdConfig.payloadHash,
    status: 'succeeded',
    result: { dockerRef: 'registry:5000/example/image:tag', dockerId: 'sha256:abc' },
  });
  const held = transformAgentWireFrame(terminal, holdConfig, initial, {
    released: false,
    now: new Date('2026-07-17T00:00:01.000Z'),
  });
  assert.equal(held.action, 'drop');
  assert.equal(held.text, null);
  assert.equal(held.evidence.droppedCount, 1);
  assert.equal(held.evidence.forwardedTerminalCount, 0);

  const heldAgain = transformAgentWireFrame(terminal, holdConfig, held.evidence, {
    released: false,
    now: new Date('2026-07-17T00:00:02.000Z'),
  });
  assert.equal(heldAgain.action, 'drop');
  assert.equal(heldAgain.evidence.droppedCount, 1);
  assert.equal(heldAgain.evidence.terminalCount, 2);

  const forwarded = transformAgentWireFrame(terminal, holdConfig, heldAgain.evidence, {
    released: true,
    now: new Date('2026-07-17T00:00:03.000Z'),
  });
  assert.equal(forwarded.action, 'forward');
  assert.equal(forwarded.text, terminal);
  assert.equal(forwarded.evidence.forwardedTerminalCount, 1);
});

test('mutates only one exact successful image result and no other frame', () => {
  const mutateConfig = { ...config, mode: 'mutate-image-ref-once' };
  let evidence = observeBackendWireFrame(
    envelope('task.execute.v1', {
      taskId: mutateConfig.taskId,
      payloadHash: mutateConfig.payloadHash,
      kind: 'image.ensure_present',
      payload: {},
    }),
    mutateConfig,
    createWireProxyEvidence(mutateConfig),
  ).evidence;
  const originalResult = {
    imageId: 'sha256:image',
    dockerId: 'sha256:image',
    dockerRef: 'registry:5000/example/image:tag',
  };
  const terminal = envelope('task.result.v1', {
    taskId: mutateConfig.taskId,
    payloadHash: mutateConfig.payloadHash,
    status: 'succeeded',
    result: originalResult,
  });
  const mutated = transformAgentWireFrame(terminal, mutateConfig, evidence);
  assert.equal(mutated.action, 'forward');
  assert.equal(mutated.evidence.mutatedCount, 1);
  const parsed = JSON.parse(mutated.text);
  assert.deepEqual(
    { ...parsed.payload.result, dockerRef: originalResult.dockerRef },
    originalResult,
  );
  assert.equal(
    parsed.payload.result.dockerRef,
    `registry:5000/${mutateConfig.runId}/provider-invalid-result:${mutateConfig.nodeKey}`,
  );

  evidence = mutated.evidence;
  const second = transformAgentWireFrame(terminal, mutateConfig, evidence);
  assert.equal(second.text, terminal);
  assert.equal(second.evidence.mutatedCount, 1);

  const wrongHash = terminal.replace(mutateConfig.payloadHash, 'b'.repeat(64));
  assert.deepEqual(transformAgentWireFrame(wrongHash, mutateConfig, second.evidence), {
    action: 'forward',
    text: wrongHash,
    evidence: second.evidence,
  });
  const failed = envelope('task.result.v1', {
    taskId: mutateConfig.taskId,
    payloadHash: mutateConfig.payloadHash,
    status: 'failed',
    error: { code: 'expected', message: 'expected' },
    observed: {},
  });
  const freshEvidence = { ...evidence, mutatedCount: 0 };
  assert.equal(transformAgentWireFrame(failed, mutateConfig, freshEvidence).text, failed);
});
