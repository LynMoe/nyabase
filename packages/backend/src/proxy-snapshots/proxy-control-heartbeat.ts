import type { WebSocket } from 'ws';

/** How often the Backend pings each admitted proxy control socket. */
export const PROXY_CONTROL_PING_INTERVAL_MS = 15_000;

/**
 * Drops proxy control sockets whose peer is gone without a close (proxy host
 * power loss, a dropped NAT entry, a partition). Such a half-open socket
 * would otherwise stay "connected" until TCP gives up, up to about 15
 * minutes, and hold one of the gateway's few client slots
 * (`MAX_*_PROXY_CLIENTS`), so a legitimate reconnect could be refused.
 *
 * Every interval each tracked socket that delivered nothing since the
 * previous tick (no pong, no message) is terminated, and every other one is
 * pinged; a live proxy answers the ping (and also sends its own pings and
 * status frames). A dead peer is therefore dropped within two intervals.
 */
export class ProxyControlHeartbeat {
  private readonly heardFrom = new WeakMap<WebSocket, boolean>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly sockets: () => Iterable<WebSocket>,
    private readonly intervalMs = PROXY_CONTROL_PING_INTERVAL_MS,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Starts watching an admitted socket; any frame from it counts as alive. */
  track(socket: WebSocket): void {
    this.heardFrom.set(socket, true);
    const alive = () => this.heardFrom.set(socket, true);
    socket.on('pong', alive);
    socket.on('message', alive);
    socket.on('ping', alive);
  }

  tick(): void {
    for (const socket of this.sockets()) {
      if (this.heardFrom.get(socket) !== true) {
        // `close` follows, which removes the socket from the gateway.
        socket.terminate();
        continue;
      }
      this.heardFrom.set(socket, false);
      try {
        socket.ping();
      } catch {
        socket.terminate();
      }
    }
  }
}
