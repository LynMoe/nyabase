import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentHostStatus, FirewallDocument } from '@nyabase/common';
import type { AgentPresenceListener } from '../incus/agent-registry.service.js';
import { IncusError } from '../incus/incus-errors.js';
import { FIREWALL_RETRY_INITIAL_MS, FIREWALL_RETRY_MAX_MS, FirewallSyncService } from './firewall-sync.service.js';
import type { FirewallServerRuleRow } from './firewall.repository.js';

const SERVER = '11111111-1111-4111-8111-111111111111';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function rule(cidr: string, priority = 1): FirewallServerRuleRow {
  return { server_id: SERVER, priority, action: 'drop', protocol: 'all', ports: [], cidrs: [cidr] };
}

/** A fake agent connection whose `firewall.apply` replies are driven by the test. */
class FakeConnection {
  status: AgentHostStatus = {
    ipv6Guard: { present: true, error: null },
    firewall: { present: false, digest: null, error: null },
  };
  readonly calls: Array<{ document: FirewallDocument; reply: Deferred<string> }> = [];

  applyFirewall(document: FirewallDocument): Promise<string> {
    const reply = deferred<string>();
    this.calls.push({ document, reply });
    return reply.promise;
  }

  /** Answer the latest call as the agent would on success. */
  confirm(): void {
    const call = this.calls.at(-1)!;
    this.status = { ...this.status, firewall: { present: true, digest: call.document.digest, error: null } };
    call.reply.resolve(call.document.digest);
  }
}

function harness() {
  let rows: FirewallServerRuleRow[] = [];
  let listener!: AgentPresenceListener;
  let connection: FakeConnection | undefined;
  const agents = {
    onPresence: vi.fn((value: AgentPresenceListener) => {
      listener = value;
      return () => undefined;
    }),
    current: vi.fn((serverId: string) => (serverId === SERVER ? connection : undefined)),
    isConnected: vi.fn((serverId: string) => serverId === SERVER && connection !== undefined),
  };
  const repository = {
    listServerRules: vi.fn(async (serverIds: readonly string[]) =>
      rows.filter((row) => serverIds.includes(row.server_id))),
  };
  const sync = new FirewallSyncService(agents as never, repository as never);
  sync.onModuleInit();
  return {
    sync,
    repository,
    setRules: (next: FirewallServerRuleRow[]) => {
      rows = next;
    },
    connect: async () => {
      connection = new FakeConnection();
      await listener.connected(SERVER, {} as never);
      return connection;
    },
    disconnect: async () => {
      connection = undefined;
      await listener.disconnected(SERVER);
    },
    reportStatus: async (status: AgentHostStatus) => {
      connection!.status = status;
      await listener.status?.(SERVER, status);
    },
  };
}

/** Let queued promise callbacks (DB read, reply handling) run. */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

describe('FirewallSyncService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pushes on every new connection, even when the agent already holds the digest', async () => {
    const h = harness();
    h.setRules([rule('10.0.0.0/8')]);
    const first = await h.connect();
    await settle();
    expect(first.calls).toHaveLength(1);
    first.confirm();
    await settle();

    await h.disconnect();
    const second = await h.connect();
    second.status = { ...second.status, firewall: { present: false, digest: first.calls[0]!.document.digest, error: null } };
    await settle();
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.document).toEqual(first.calls[0]!.document);
  });

  it('runs one push per server at a time and repeats it once when rules changed meanwhile', async () => {
    const h = harness();
    const agent = await h.connect();
    await settle();
    expect(agent.calls).toHaveLength(1);
    expect(agent.calls[0]!.document.rules).toEqual([]);

    h.setRules([rule('10.0.0.0/8')]);
    h.sync.rulesChanged([SERVER]);
    h.setRules([rule('10.0.0.0/8'), rule('192.168.0.0/16', 2)]);
    h.sync.rulesChanged([SERVER, SERVER]);
    await settle();
    expect(agent.calls).toHaveLength(1);

    agent.confirm();
    await settle();
    expect(agent.calls).toHaveLength(2);
    expect(agent.calls[1]!.document.rules.map((item) => item.cidrs)).toEqual([['10.0.0.0/8'], ['192.168.0.0/16']]);
    agent.confirm();
    await settle();
    expect(agent.calls).toHaveLength(2);

    // A change that leaves the document as it is (e.g. a rename) sends nothing.
    h.sync.rulesChanged([SERVER]);
    await settle();
    expect(agent.calls).toHaveLength(2);
  });

  it('retries transport and agent failures with doubling backoff up to five minutes', async () => {
    const h = harness();
    const agent = await h.connect();
    await settle();
    const delays: number[] = [];
    let expected = FIREWALL_RETRY_INITIAL_MS;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      agent.calls.at(-1)!.reply.reject(new IncusError('INCUS_TIMEOUT', 'retry', { reason: 'agent_response_timeout' }));
      await settle();
      const before = agent.calls.length;
      await vi.advanceTimersByTimeAsync(expected - 1);
      expect(agent.calls).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(agent.calls).toHaveLength(before + 1);
      delays.push(expected);
      expected = Math.min(expected * 2, FIREWALL_RETRY_MAX_MS);
    }
    expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000]);
    const [status] = await h.sync.statuses([{ id: SERVER, name: 'worker' }]);
    expect(status).toMatchObject({ state: 'failed', error: expect.stringContaining('INCUS_TIMEOUT') });

    // Success resets the backoff.
    agent.confirm();
    await settle();
    await expect(h.sync.statuses([{ id: SERVER, name: 'worker' }])).resolves.toMatchObject([{ state: 'synced', error: null }]);
    h.setRules([rule('10.0.0.0/8')]);
    h.sync.rulesChanged([SERVER]);
    await settle();
    agent.calls.at(-1)!.reply.reject(new IncusError('AGENT_REQUEST_FAILED', 'retry', { message: 'nft failed' }));
    await settle();
    const before = agent.calls.length;
    await vi.advanceTimersByTimeAsync(FIREWALL_RETRY_INITIAL_MS);
    expect(agent.calls).toHaveLength(before + 1);
  });

  it('does not resend a document the agent refused until the rules or the connection change', async () => {
    const h = harness();
    h.setRules([rule('10.0.0.0/8')]);
    const agent = await h.connect();
    await settle();
    agent.calls[0]!.reply.reject(new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'agent', message: 'invalid document' }));
    await settle();
    await vi.advanceTimersByTimeAsync(FIREWALL_RETRY_MAX_MS * 2);
    expect(agent.calls).toHaveLength(1);
    await expect(h.sync.statuses([{ id: SERVER, name: 'worker' }])).resolves.toMatchObject([{
      state: 'failed',
      error: 'INCUS_BAD_REQUEST: invalid document',
    }]);

    // Status reports with the old digest do not bring the refused document back.
    await h.reportStatus({ ...agent.status, firewall: { present: false, digest: null, error: null } });
    await settle();
    expect(agent.calls).toHaveLength(1);

    h.setRules([rule('10.0.0.0/16')]);
    h.sync.rulesChanged([SERVER]);
    await settle();
    expect(agent.calls).toHaveLength(2);
  });

  it('pushes when the agent reports another digest and nothing is in flight', async () => {
    const h = harness();
    h.setRules([rule('10.0.0.0/8')]);
    const agent = await h.connect();
    await settle();
    // Reported while the connect push is still in flight: that push answers it.
    await h.reportStatus({ ...agent.status, firewall: { present: false, digest: null, error: 'apply failed' } });
    await settle();
    expect(agent.calls).toHaveLength(1);
    agent.confirm();
    await settle();

    const desired = agent.calls[0]!.document.digest;
    await h.reportStatus({ ...agent.status, firewall: { present: true, digest: desired, error: null } });
    await settle();
    expect(agent.calls).toHaveLength(1);

    await h.reportStatus({ ...agent.status, firewall: { present: false, digest: 'f'.repeat(64), error: null } });
    await settle();
    expect(agent.calls).toHaveLength(2);
  });

  it('forgets a server on disconnect: no retry, and late replies are ignored', async () => {
    const h = harness();
    const agent = await h.connect();
    await settle();
    agent.calls[0]!.reply.reject(new IncusError('INCUS_TIMEOUT', 'retry', {}));
    await settle();
    await h.disconnect();
    await vi.advanceTimersByTimeAsync(FIREWALL_RETRY_MAX_MS);
    expect(agent.calls).toHaveLength(1);
    await expect(h.sync.statuses([{ id: SERVER, name: 'worker' }])).resolves.toMatchObject([{
      state: 'offline',
      agentConnected: false,
      appliedDigest: null,
      error: null,
    }]);
    await expect(h.sync.agentStatuses([SERVER])).resolves.toEqual(new Map([[SERVER, null]]));

    // A reply from a dropped connection changes nothing on the new one.
    const next = await h.connect();
    await settle();
    agent.calls[0]!.reply.resolve('0'.repeat(64));
    await settle();
    expect(next.calls).toHaveLength(1);
    await expect(h.sync.agentStatuses([SERVER])).resolves.toEqual(new Map([[SERVER, { state: 'pending', error: null }]]));
  });

  it('retries when the rules cannot be read', async () => {
    const h = harness();
    h.repository.listServerRules.mockRejectedValueOnce(new Error('connection terminated'));
    const agent = await h.connect();
    await settle();
    expect(agent.calls).toHaveLength(0);
    await expect(h.sync.agentStatuses([SERVER])).resolves.toEqual(new Map([[SERVER, {
      state: 'failed',
      error: 'Reading the firewall rules failed: connection terminated',
    }]]));
    await vi.advanceTimersByTimeAsync(FIREWALL_RETRY_INITIAL_MS);
    expect(agent.calls).toHaveLength(1);
  });

  it('reports what the agent says when it lost the table on its own', async () => {
    const h = harness();
    const agent = await h.connect();
    await settle();
    agent.confirm();
    await settle();
    await h.reportStatus({
      ...agent.status,
      firewall: { present: false, digest: agent.calls[0]!.document.digest, error: 'nft: table changed' },
    });
    await settle();
    // Same digest: the agent heals it itself, nothing is resent.
    expect(agent.calls).toHaveLength(1);
    await expect(h.sync.agentStatuses([SERVER])).resolves.toEqual(new Map([[SERVER, {
      state: 'failed',
      error: 'nft: table changed',
    }]]));
  });
});
