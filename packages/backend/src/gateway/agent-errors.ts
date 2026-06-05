import {
  ServiceUnavailableException,
  GatewayTimeoutException,
  BadGatewayException,
} from '@nestjs/common';

/**
 * Translate a raw agent RPC error into the appropriate NestJS HTTP exception.
 *
 * The agent side sends back string error messages; pattern-match them to HTTP
 * status codes so that callers always get a typed HttpException and the default
 * NestJS error handler serialises them correctly (no accidental 500s).
 */
export function toAgentException(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes('Agent offline') || msg.includes('Agent not connected')) {
    throw new ServiceUnavailableException('Agent offline');
  }
  if (msg.includes('timeout') || msg.toLowerCase().includes('timed out')) {
    throw new GatewayTimeoutException('Agent RPC timed out');
  }

  // Default: surface as 502 Bad Gateway rather than 500 Internal Server Error
  throw new BadGatewayException(`Agent error: ${msg}`);
}

/**
 * Wrap an agent RPC call so that connection/timeout errors are translated to
 * HTTP exceptions automatically. Usage:
 *
 *   const result = await rpcWithErrorMapping(() =>
 *     agentGateway.rpc(serverId, 'someCommand', payload)
 *   );
 */
export async function rpcWithErrorMapping<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    toAgentException(err);
  }
}
