import { Injectable } from '@nestjs/common';
import type {
  IncusClientPort,
  IncusExecWebSocketSession,
} from '../incus/incus-client.js';
import type { ConsoleBridgePort } from './console-bridge.port.js';

@Injectable()
export class IncusConsoleBridgeAdapter implements ConsoleBridgePort {
  open(
    client: IncusClientPort,
    instanceName: string,
    command: readonly string[],
    options: {
      readonly user?: number;
      readonly group?: number;
      readonly width?: number;
      readonly height?: number;
      readonly tty?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<IncusExecWebSocketSession> {
    return client.openExecWebSockets(
      instanceName,
      {
        command: [...command],
        interactive: options.tty ?? true,
        'wait-for-websocket': true,
        width: options?.width,
        height: options?.height,
        user: options?.user,
        group: options?.group,
      },
      {
        signal: options.signal,
        channels: options.tty === false ? ['0', '1', '2'] : ['0', 'control'],
      },
    );
  }
}
