import type { RawData, WebSocket } from 'ws';

/** Browser frames bound for the exec stream. */
export type ConsoleExecFrame =
  | { readonly type: 'input'; readonly data: string }
  | { readonly type: 'resize'; readonly cols: number; readonly rows: number };

/**
 * Input / resize frames sent before the exec stream is open are held, up to
 * this many bytes, and replayed once it is; past it the console closes instead
 * of dropping keys.
 */
export const MAX_CONSOLE_PENDING_INPUT_BYTES = 256 * 1024;

export interface ConsoleFrameEvents {
  /** A frame that is not JSON. */
  invalid(): void;
  /** More input arrived before the exec stream opened than is held. */
  overflow(): void;
}

/**
 * The single `message` listener of a console socket, attached as the socket
 * opens and kept for its whole life, so no frame falls between phases. The
 * first frame must be `auth` and resolves `firstAuth`; later `auth` frames go
 * to the re-authentication handler and `input` / `resize` to the exec stream,
 * each held until its handler is attached: a re-authentication prompt can be
 * answered while the console is still being authorized or the exec opened.
 */
export class ConsoleFrameDispatcher {
  readonly firstAuth: Promise<string>;
  private awaitingFirst: {
    resolve(token: string): void;
    reject(error: Error): void;
    timer: NodeJS.Timeout;
  } | null = null;
  private authHandler: ((token: string) => void) | null = null;
  /** Only the newest token counts; an older one would be superseded anyway. */
  private pendingToken: string | null = null;
  private execHandler: ((frame: ConsoleExecFrame) => void) | null = null;
  private pendingExec: ConsoleExecFrame[] = [];
  private pendingExecBytes = 0;

  constructor(socket: WebSocket, private readonly events: ConsoleFrameEvents, authTimeoutMs: number) {
    this.firstAuth = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaitingFirst = null;
        reject(new Error('Console authentication timed out'));
      }, authTimeoutMs);
      this.awaitingFirst = { resolve, reject, timer };
    });
    // A failed first frame is reported through `firstAuth` only.
    this.firstAuth.catch(() => undefined);
    socket.on('message', (raw) => this.dispatch(raw));
  }

  /** Route later `auth` frames (and one already received) to `handler`. */
  onAuth(handler: (token: string) => void): void {
    this.authHandler = handler;
    const token = this.pendingToken;
    this.pendingToken = null;
    if (token !== null) handler(token);
  }

  /** Route exec frames (and those held so far, in order) to `handler`. */
  onExec(handler: (frame: ConsoleExecFrame) => void): void {
    this.execHandler = handler;
    const held = this.pendingExec;
    this.pendingExec = [];
    this.pendingExecBytes = 0;
    for (const frame of held) handler(frame);
  }

  private dispatch(raw: RawData): void {
    const text = raw.toString();
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      if (!this.failFirst('Console authentication frame is invalid')) this.events.invalid();
      return;
    }
    const frame = message && typeof message === 'object' && !Array.isArray(message)
      ? message as Record<string, unknown>
      : {};
    const token = frame.type === 'auth' && typeof frame.token === 'string' ? frame.token : null;
    if (this.awaitingFirst) {
      if (token === null) {
        this.failFirst('Console authentication frame is invalid');
        return;
      }
      const first = this.awaitingFirst;
      this.awaitingFirst = null;
      clearTimeout(first.timer);
      first.resolve(token);
      return;
    }
    if (token !== null) {
      if (this.authHandler) this.authHandler(token);
      else this.pendingToken = token;
      return;
    }
    const exec = execFrame(frame);
    if (!exec) return;
    if (this.execHandler) {
      this.execHandler(exec);
      return;
    }
    this.pendingExecBytes += Buffer.byteLength(text);
    if (this.pendingExecBytes > MAX_CONSOLE_PENDING_INPUT_BYTES) {
      this.pendingExec = [];
      this.pendingExecBytes = 0;
      this.events.overflow();
      return;
    }
    this.pendingExec.push(exec);
  }

  /** True when the frame was the (failed) first one. */
  private failFirst(reason: string): boolean {
    const first = this.awaitingFirst;
    if (!first) return false;
    this.awaitingFirst = null;
    clearTimeout(first.timer);
    first.reject(new Error(reason));
    return true;
  }
}

function execFrame(frame: Record<string, unknown>): ConsoleExecFrame | null {
  if (frame.type === 'input' && typeof frame.data === 'string') {
    return { type: 'input', data: frame.data };
  }
  if (
    frame.type === 'resize'
    && Number.isSafeInteger(frame.cols)
    && Number.isSafeInteger(frame.rows)
  ) {
    return { type: 'resize', cols: frame.cols as number, rows: frame.rows as number };
  }
  return null;
}
