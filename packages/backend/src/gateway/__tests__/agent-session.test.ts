import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  AgentRpcTransportError,
  AgentSession,
  MAX_AGENT_SESSION_BUFFERED_BYTES,
  MAX_AGENT_SESSION_PENDING_RPCS,
} from '../agent-session.js';
import { MAX_AGENT_WS_FRAME_BYTES } from '@nyabase/common';

function makeWs(readyState: number = WebSocket.OPEN, bufferedAmount = 0) {
  return {
    readyState,
    bufferedAmount,
    send: vi.fn(),
    terminate: vi.fn(),
  } as unknown as WebSocket;
}

describe('AgentSession.rpc', () => {
  it('resolves when ack arrives before timeout', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    const promise = session.rpc<{ dockerId: string }>('selfCheck', {}, 1000);

    // Extract the id from the sent envelope to use in resolveAck
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    session.resolveAck(sent.id, true, undefined, { dockerId: 'abc' });

    await expect(promise).resolves.toEqual({ dockerId: 'abc' });
  });

  it('rejects with timeout error when no ack arrives', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    await expect(
      session.rpc('selfCheck', {}, 10), // 10 ms timeout
    ).rejects.toThrow('Agent RPC timeout');
  });

  it('rejects with agent error when ack has ok=false', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    const promise = session.rpc('selfCheck', {}, 1000);
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    session.resolveAck(sent.id, false, 'container not found');

    await expect(promise).rejects.toThrow('container not found');
  });

  it('rejects immediately when ws is not OPEN', async () => {
    const ws = makeWs(WebSocket.CLOSED);
    const session = new AgentSession('srv-1', ws);

    const rpc = session.rpc('selfCheck', {});
    await expect(rpc).rejects.toBeInstanceOf(AgentRpcTransportError);
    await expect(rpc).rejects.toThrow('Agent not connected or outbound buffer is full');
  });

  it('terminates a connection whose outbound buffer exceeds the hard limit', async () => {
    const ws = makeWs(WebSocket.OPEN, MAX_AGENT_SESSION_BUFFERED_BYTES + 1);
    const session = new AgentSession('srv-1', ws);

    expect(session.send({ id: undefined, ts: Date.now(), kind: 'reconcile', payload: { serverId: 'srv-1' } })).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
    await expect(session.rpc('selfCheck', {})).rejects.toThrow(
      'Agent connection exceeded the outbound backpressure limit',
    );
  });

  it('terminates rather than sending a single frame above the protocol ceiling', () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    expect(session.send({
      id: undefined,
      ts: Date.now(),
      kind: 'reconcile',
      payload: { serverId: 'x'.repeat(MAX_AGENT_WS_FRAME_BYTES) },
    })).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledOnce();
  });

  it('rejects excess concurrent RPCs instead of growing the pending map without bound', async () => {
    const session = new AgentSession('srv-1', makeWs());
    const pending = Array.from({ length: MAX_AGENT_SESSION_PENDING_RPCS }, () =>
      session.rpc('selfCheck', {}, 60_000));

    await expect(session.rpc('selfCheck', {}, 60_000))
      .rejects.toThrow('Agent RPC limit');
    session.rejectAll('test cleanup');
    await Promise.allSettled(pending);
  });
});

describe('AgentSession.rejectAll', () => {
  it('rejects all pending RPCs with the given reason', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    const p1 = session.rpc('selfCheck', {}, 5000);
    const p2 = session.rpc('inspectContainer', { containerId: 'container-a', runtimeId: 'runtime-a' }, 5000);

    session.rejectAll('Agent disconnected');

    await expect(p1).rejects.toBeInstanceOf(AgentRpcTransportError);
    await expect(p2).rejects.toBeInstanceOf(AgentRpcTransportError);
  });
});

describe('AgentSession handshake readiness', () => {
  it('starts non-dispatchable, accepts one hello, and becomes ready only explicitly', () => {
    const session = new AgentSession('srv-1', makeWs());

    expect(session.dispatchReady).toBe(false);
    expect(session.hasReceivedHello).toBe(false);
    expect(session.beginHello()).toBe(true);
    expect(session.beginHello()).toBe(false);
    expect(session.hasReceivedHello).toBe(true);

    session.markDispatchReady();
    expect(session.dispatchReady).toBe(true);
  });

  it('tracks the inbound heartbeat deadline monotonically', () => {
    const session = new AgentSession('srv-1', makeWs());
    session.markInbound(1_000);
    expect(session.inboundExpired(20_999, 20_000)).toBe(false);
    expect(session.inboundExpired(21_001, 20_000)).toBe(true);
    session.markInbound(21_001);
    expect(session.inboundExpired(40_000, 20_000)).toBe(false);
  });

  it('gives pre-hello Docker convergence its own finite budget', () => {
    const session = new AgentSession('srv-1', makeWs());
    session.markInbound(1_000);
    expect(session.inboundExpired(21_001, 20_000, 150_000)).toBe(false);
    expect(session.inboundExpired(151_000, 20_000, 150_000)).toBe(false);
    expect(session.inboundExpired(151_001, 20_000, 150_000)).toBe(true);
    expect(session.beginHello()).toBe(true);
    session.markInbound(151_001);
    expect(session.inboundExpired(171_002, 20_000, 150_000)).toBe(true);
  });

  it('rejects stale or duplicate authoritative report sequences', () => {
    const session = new AgentSession('srv-1', makeWs());
    expect(session.acceptReportSequence('state', 2)).toBe(true);
    expect(session.acceptReportSequence('state', 2)).toBe(false);
    expect(session.acceptReportSequence('state', 1)).toBe(false);
    expect(session.acceptReportSequence('state', 3)).toBe(true);
  });

  it('expires a bootstrapped session that never provides its initial full report', () => {
    const session = new AgentSession('server-a', makeWs() as never);
    session.markBootstrapReady(1_000);
    expect(session.initializationExpired(30_999, 30_000)).toBe(false);
    expect(session.initializationExpired(31_001, 30_000)).toBe(true);
    session.markDispatchReady();
    expect(session.initializationExpired(100_000, 30_000)).toBe(false);
  });
});
