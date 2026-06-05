import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AgentCommandKind, type AgentCommandEnvelope } from '@nyabase/common';
import { AgentSession } from '../agent-session.js';

function makeWs(readyState: number = WebSocket.OPEN) {
  return {
    readyState,
    send: vi.fn(),
  } as unknown as WebSocket;
}

function agentCommand(commandId = 'command-a'): AgentCommandEnvelope {
  return {
    operationId: 'operation-a',
    commandId,
    commandKind: AgentCommandKind.RuntimeContainerPower,
    idempotencyKey: `${commandId}:start`,
    resourceKey: 'container:abc',
    desiredGeneration: 1,
    payload: { dockerId: 'abc', action: 'start' },
  };
}

describe('AgentSession.rpc', () => {
  it('resolves when ack arrives before timeout', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    const promise = session.rpc<{ dockerId: string }>('agentCommand', agentCommand(), 1000);

    // Extract the id from the sent envelope to use in resolveAck
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    session.resolveAck(sent.id, true, undefined, { dockerId: 'abc' });

    await expect(promise).resolves.toEqual({ dockerId: 'abc' });
  });

  it('rejects with timeout error when no ack arrives', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    await expect(
      session.rpc('agentCommand', agentCommand(), 10), // 10 ms timeout
    ).rejects.toThrow('Agent RPC timeout');
  });

  it('rejects with agent error when ack has ok=false', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    const promise = session.rpc('agentCommand', agentCommand(), 1000);
    const sent = JSON.parse((ws.send as ReturnType<typeof vi.fn>).mock.calls[0][0] as string);
    session.resolveAck(sent.id, false, 'container not found');

    await expect(promise).rejects.toThrow('container not found');
  });

  it('rejects immediately when ws is not OPEN', async () => {
    const ws = makeWs(WebSocket.CLOSED);
    const session = new AgentSession('srv-1', ws);

    await expect(
      session.rpc('agentCommand', agentCommand()),
    ).rejects.toThrow('Agent not connected');
  });
});

describe('AgentSession.rejectAll', () => {
  it('rejects all pending RPCs with the given reason', async () => {
    const ws = makeWs();
    const session = new AgentSession('srv-1', ws);

    const p1 = session.rpc('agentCommand', agentCommand('command-a'), 5000);
    const p2 = session.rpc('fetchContainerStats', { dockerId: 'abc' }, 5000);

    session.rejectAll('Agent disconnected');

    await expect(p1).rejects.toThrow('Agent disconnected');
    await expect(p2).rejects.toThrow('Agent disconnected');
  });
});
