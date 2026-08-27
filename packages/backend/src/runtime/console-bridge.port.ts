import type { IncusClientPort, IncusExecWebSocketSession } from '../incus/incus-client.js';

export const CONSOLE_BRIDGE = Symbol('CONSOLE_BRIDGE');

/**
 * The Incus exec websocket bridge is the only supported console boundary.
 * The HTTP/WebSocket adapter owns this boundary; reconciliation never opens
 * console sessions directly.
 */
export interface ConsoleBridgePort {
  open(
    client: IncusClientPort,
    instanceName: string,
    command: readonly string[],
    options?: {
      readonly user?: number;
      readonly group?: number;
      readonly width?: number;
      readonly height?: number;
      readonly tty?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<IncusExecWebSocketSession>;
}

