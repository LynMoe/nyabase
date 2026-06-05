import { describe, it, expect } from 'vitest';
import { ServiceUnavailableException, GatewayTimeoutException, BadGatewayException } from '@nestjs/common';
import { toAgentException, rpcWithErrorMapping } from '../agent-errors.js';

describe('toAgentException', () => {
  it('maps "Agent offline" to ServiceUnavailableException', () => {
    expect(() => toAgentException(new Error('Agent offline'))).toThrow(ServiceUnavailableException);
  });

  it('maps "Agent not connected" to ServiceUnavailableException', () => {
    expect(() => toAgentException(new Error('Agent not connected'))).toThrow(ServiceUnavailableException);
  });

  it('maps timeout errors to GatewayTimeoutException', () => {
    expect(() => toAgentException(new Error('Agent RPC timeout: createContainer (id=abc)'))).toThrow(GatewayTimeoutException);
  });

  it('maps unknown errors to BadGatewayException', () => {
    expect(() => toAgentException(new Error('some unexpected error'))).toThrow(BadGatewayException);
  });

  it('handles non-Error thrown values', () => {
    expect(() => toAgentException('something went wrong')).toThrow(BadGatewayException);
  });
});

describe('rpcWithErrorMapping', () => {
  it('returns the resolved value on success', async () => {
    const result = await rpcWithErrorMapping(() => Promise.resolve({ dockerId: 'abc123' }));
    expect(result).toEqual({ dockerId: 'abc123' });
  });

  it('translates agent errors on failure', async () => {
    await expect(
      rpcWithErrorMapping(() => Promise.reject(new Error('Agent offline'))),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});
