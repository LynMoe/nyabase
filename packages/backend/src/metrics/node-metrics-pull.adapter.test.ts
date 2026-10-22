import { describe, expect, it, vi } from 'vitest';
import { IncusError } from '../incus/index.js';
import { AgentNodeMetricsPullAdapter } from './node-metrics-pull.adapter.js';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';

function registry(collect: () => Promise<string>) {
  return {
    require: vi.fn(() => ({ collectMetrics: vi.fn(collect) })),
  };
}

describe('AgentNodeMetricsPullAdapter', () => {
  it('parses what the agent collected', async () => {
    const adapter = new AgentNodeMetricsPullAdapter(registry(async () => [
      '# TYPE nyabase_node_ipv6_guard_present gauge',
      'nyabase_node_ipv6_guard_present 1',
      '# TYPE nyabase_node_network_nft_available gauge',
      'nyabase_node_network_nft_available 1',
      '# EOF',
      '',
    ].join('\n')) as never);
    const result = await adapter.pull(SERVER_ID);
    expect(result.status).toBe('online');
    expect(result.report.metrics).toMatchObject({
      nyabase_node_ipv6_guard_present: 1,
      nyabase_node_network_nft_available: 1,
    });
  });

  it('reports an unreachable agent as a typed failure', async () => {
    const adapter = new AgentNodeMetricsPullAdapter({
      require: vi.fn(() => {
        throw new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected' });
      }),
    } as never);
    await expect(adapter.pull(SERVER_ID)).rejects.toMatchObject({ code: 'NODE_METRICS_UNREACHABLE' });
  });

  it('refuses metrics outside the allowlisted catalog', async () => {
    const adapter = new AgentNodeMetricsPullAdapter(registry(async () => [
      '# TYPE secret_token gauge',
      'secret_token{value="x"} 1',
      '# EOF',
      '',
    ].join('\n')) as never);
    await expect(adapter.pull(SERVER_ID)).rejects.toMatchObject({ code: 'NODE_METRICS_INVALID_RESPONSE' });
  });
});
