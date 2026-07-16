import * as net from 'net';

export interface ProcessGuard {
  readonly address: string;
  release(): Promise<void>;
}

/**
 * An abstract Unix listener is a kernel-lifetime lock: it cannot leave a stale
 * file after SIGKILL, and bind is atomic between racing Agent processes.
 */
export async function acquireProcessGuard(serverId: string): Promise<ProcessGuard> {
  const address = processGuardAddress(serverId);
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Another nyabase-agent process already owns this host (${serverId})`));
        return;
      }
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(address);
  });
  server.unref();

  let released = false;
  return {
    address,
    async release() {
      if (released) return;
      released = true;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

export function processGuardAddress(serverId: string): string {
  void serverId;
  return '\0nyabase-agent-host-global-v1';
}
