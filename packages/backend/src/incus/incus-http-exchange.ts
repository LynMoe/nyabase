import type { IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { IncusError, mapIncusApiFailure, mapIncusTransportError, normalizeCertificateFingerprint } from './incus-errors.js';
import type {
  IncusEnvelope,
  IncusFileResponse,
  IncusRequestFactory,
  IncusRequestLike,
  IncusRequestOptions,
  IncusResponse,
  IncusTimeouts,
  IncusTlsOptions,
} from './incus-client-types.js';
import { headerValue, parseNumberHeader } from './incus-request-util.js';

export type ExchangeResult =
  | { readonly kind: 'json'; readonly value: IncusResponse<unknown> }
  | {
      readonly kind: 'raw';
      readonly value: Omit<IncusFileResponse, 'uid' | 'gid' | 'mode' | 'type' | 'modified'>;
    };

/** What an exchange needs from the client that owns the connection settings. */
export interface ExchangeHost {
  readonly timeouts: IncusTimeouts;
  readonly maxBodyBytes: number;
  readonly requestFactory: IncusRequestFactory;
  readonly tlsOptions: IncusTlsOptions;
  /** The accepted server leaf fingerprint; set once trust-on-first-use succeeded. */
  readonly serverFingerprint?: string | undefined;
  acceptPeerFingerprint(raw: Buffer): Promise<void>;
}

type Phase = 'connect' | 'headers' | 'body' | 'total';

interface ActiveSocket {
  setTimeout(timeout: number, callback?: () => void): void;
  once(event: string, listener: (...args: never[]) => void): void;
  removeListener?(event: string, listener: (...args: never[]) => void): unknown;
  getPeerCertificate?: (detailed?: boolean) => { raw?: Buffer };
  authorized?: boolean;
  secureConnecting?: boolean;
}

/** Turn a complete response into a result, or throw the matching Incus error. */
export function parseResponse(
  response: IncomingMessage,
  payload: Buffer,
  responseType: 'json' | 'raw',
  requestPath: string,
): ExchangeResult {
  const status = response.statusCode ?? 0;
  const etag = headerValue(response.headers, 'etag');
  if (responseType === 'raw' && status >= 200 && status < 300) {
    return { kind: 'raw', value: { status, headers: response.headers, etag, body: payload } };
  }

  let parsed: unknown;
  if (payload.byteLength > 0) {
    try {
      parsed = JSON.parse(payload.toString('utf8'));
    } catch {
      if (status >= 400) {
        throw mapIncusApiFailure({
          status,
          errorText: payload.toString('utf8').slice(0, 256),
          details: { path: requestPath },
        });
      }
      throw new IncusError('INCUS_JSON_ERROR', 'managed_failure', { status });
    }
  }

  const envelope =
    typeof parsed === 'object' && parsed !== null
      ? (parsed as IncusEnvelope<unknown>)
      : undefined;
  const apiStatus =
    typeof envelope?.status_code === 'number' && envelope.status_code > 0
      ? envelope.status_code
      : typeof envelope?.error_code === 'number' && envelope.error_code > 0
        ? envelope.error_code
        : status;
  if (status < 200 || status >= 300 || envelope?.type === 'error') {
    throw mapIncusApiFailure({
      status: apiStatus,
      apiErrorCode: envelope?.error_code,
      errorText: envelope?.error,
      operationId: envelope?.operation,
      details: { path: requestPath },
    });
  }
  if (!envelope || typeof envelope !== 'object') {
    throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', { status });
  }
  return {
    kind: 'json',
    value: {
      status,
      headers: response.headers,
      etag,
      envelope,
      metadata: envelope.metadata,
    },
  };
}

/**
 * One HTTPS request/response with phase timeouts (connect, headers, body,
 * total), an abort signal, a response size cap and trust-on-first-use
 * verification of the server's leaf certificate.
 */
class Exchange {
  private request: IncusRequestLike | undefined;
  private settled = false;
  private phase: Phase = 'connect';
  private connectTimer: NodeJS.Timeout | undefined;
  private headersTimer: NodeJS.Timeout | undefined;
  private bodyTimer: NodeJS.Timeout | undefined;
  private totalTimer: NodeJS.Timeout | undefined;
  private tlsVerified = false;
  private tlsVerificationStarted = false;
  private tlsVerification: Promise<void> = new Promise(() => undefined);
  private activeSocket: ActiveSocket | undefined;
  private socketTimeoutCallback: (() => void) | undefined;
  private secureConnectListener: ((...args: never[]) => void) | undefined;
  private resolve!: (value: ExchangeResult) => void;
  private reject!: (error: unknown) => void;
  private readonly requestDeadlineMs: number;
  private readonly responseHeadersTimeoutMs: number;
  private readonly responseBodyTimeoutMs: number;

  constructor(
    private readonly host: ExchangeHost,
    private readonly requestOptions: RequestOptions,
    private readonly body: Buffer | undefined,
    private readonly options: IncusRequestOptions,
    private readonly path: string,
    requestDeadlineMs: number,
  ) {
    this.requestDeadlineMs = requestDeadlineMs;
    this.responseHeadersTimeoutMs =
      options.timeoutMs === undefined ? host.timeouts.headersMs : requestDeadlineMs;
    this.responseBodyTimeoutMs =
      options.timeoutMs === undefined ? host.timeouts.bodyMs : requestDeadlineMs;
  }

  run(): Promise<ExchangeResult> {
    return new Promise<ExchangeResult>((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
      this.totalTimer = setTimeout(() => this.timeout('total'), this.requestDeadlineMs);
      this.headersTimer = setTimeout(() => this.timeout('headers'), this.responseHeadersTimeoutMs);
      this.options.signal?.addEventListener('abort', this.abort, { once: true });
      if (this.options.signal?.aborted) {
        this.abort();
        return;
      }
      try {
        this.request = this.host.requestFactory(this.requestOptions, (response) => {
          if (this.settled) return;
          this.consumeResponse(response);
        });
        this.request.once('error', (error: unknown) => this.fail(error, this.phase));
        this.request.once('socket', (socketValue: unknown) => {
          this.onSocket(socketValue as ActiveSocket);
        });
        if (this.body) this.request.write(this.body);
        this.request.end();
      } catch (error) {
        this.fail(error, this.phase);
      }
    });
  }

  private clearSocketTimeout(): void {
    if (!this.activeSocket) return;
    if (this.socketTimeoutCallback) {
      this.activeSocket.removeListener?.('timeout', this.socketTimeoutCallback);
      this.socketTimeoutCallback = undefined;
    }
    this.activeSocket.setTimeout(0);
  }

  private setSocketTimeout(timeoutMs: number, callback: () => void): void {
    this.clearSocketTimeout();
    if (!this.activeSocket) return;
    this.socketTimeoutCallback = callback;
    this.activeSocket.setTimeout(timeoutMs, callback);
  }

  private cleanup(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.headersTimer) clearTimeout(this.headersTimer);
    if (this.bodyTimer) clearTimeout(this.bodyTimer);
    if (this.totalTimer) clearTimeout(this.totalTimer);
    this.clearSocketTimeout();
    if (this.activeSocket && this.secureConnectListener) {
      this.activeSocket.removeListener?.('secureConnect', this.secureConnectListener);
      this.secureConnectListener = undefined;
    }
    this.options.signal?.removeEventListener('abort', this.abort);
  }

  private fail(error: unknown, failurePhase: Phase = this.phase): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.request?.destroy(error instanceof Error ? error : undefined);
    this.reject(error instanceof IncusError ? error : mapIncusTransportError(error, failurePhase));
  }

  private readonly abort = (): void => {
    this.fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'total' }), 'total');
  };

  private timeout(timeoutPhase: Phase): void {
    this.fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: timeoutPhase }), timeoutPhase);
  }

  private complete(value: ExchangeResult): void {
    if (this.settled) return;
    this.settled = true;
    this.cleanup();
    this.resolve(value);
  }

  private resetBodyTimer(): void {
    if (this.bodyTimer) clearTimeout(this.bodyTimer);
    this.bodyTimer = setTimeout(() => this.timeout('body'), this.responseBodyTimeoutMs);
  }

  private bodyTooLarge(): IncusError {
    return new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
      reason: 'body_too_large',
    });
  }

  private consumeResponse(response: IncomingMessage): void {
    if (this.settled) return;
    this.phase = 'body';
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.headersTimer) clearTimeout(this.headersTimer);
    this.resetBodyTimer();
    const chunks: Buffer[] = [];
    let bodyBytes = 0;
    const contentLength = parseNumberHeader(response.headers, 'content-length');
    if (contentLength !== undefined && contentLength > this.host.maxBodyBytes) {
      this.fail(this.bodyTooLarge(), 'body');
      return;
    }
    response.on('data', (chunk: Buffer | string) => {
      if (this.settled) return;
      this.resetBodyTimer();
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bodyBytes += buffer.byteLength;
      if (bodyBytes > this.host.maxBodyBytes) {
        this.fail(this.bodyTooLarge(), 'body');
        return;
      }
      chunks.push(buffer);
    });
    response.once('aborted', () => this.timeout('body'));
    response.once('error', (error: unknown) => this.fail(error, 'body'));
    response.once('end', () => {
      if (this.settled) return;
      const finish = (): void => this.finishResponse(response, Buffer.concat(chunks));
      if (this.tlsVerified) {
        finish();
        return;
      }
      void this.tlsVerification.then(finish).catch((error: unknown) => this.fail(error, 'connect'));
    });
  }

  private finishResponse(response: IncomingMessage, payload: Buffer): void {
    if (this.settled) return;
    if (this.bodyTimer) clearTimeout(this.bodyTimer);
    let result: ExchangeResult;
    try {
      result = parseResponse(
        response,
        payload,
        this.options.responseType ?? 'json',
        this.requestOptions.path ?? this.path,
      );
    } catch (error) {
      this.fail(error, 'body');
      return;
    }
    this.complete(result);
  }

  private markTlsVerified(): void {
    if (this.settled) return;
    this.tlsVerified = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.phase = 'headers';
    this.setSocketTimeout(this.responseHeadersTimeoutMs, () => this.timeout('headers'));
  }

  private onSocket(socket: ActiveSocket): void {
    this.activeSocket = socket;
    this.connectTimer = setTimeout(() => this.timeout('connect'), this.host.timeouts.connectMs);
    this.setSocketTimeout(this.host.timeouts.connectMs, () => this.timeout('connect'));
    // If the handshake is still in progress, wait for secureConnect. If it
    // already completed (including agent-reused sockets), verify immediately —
    // waiting for secureConnect after the fact hangs until connect timeout.
    if (socket.secureConnecting === true) {
      this.waitForSecureConnect(socket);
    } else {
      this.verifyTls(socket);
    }
  }

  private waitForSecureConnect(socket: ActiveSocket): void {
    this.secureConnectListener = () => this.verifyTls(socket);
    socket.once('secureConnect', this.secureConnectListener);
  }

  /** Check the server's leaf certificate against the pin (or accept it on first use). */
  private verifyTls(socket: ActiveSocket): void {
    if (this.settled || this.tlsVerified || this.tlsVerificationStarted) return;
    // An already-accepted leaf pin is enforced by checkServerIdentity.
    // After secureConnect, getPeerCertificate().raw can be empty on some
    // Node/OpenSSL paths (rejectUnauthorized=false); do not re-fail.
    // expectedFingerprint alone is not yet accepted — still TOFU-verify.
    if (this.host.serverFingerprint && socket.secureConnecting !== true) {
      this.tlsVerificationStarted = true;
      this.tlsVerification = Promise.resolve().then(() => this.markTlsVerified());
      return;
    }
    const certificate = socket.getPeerCertificate?.(true);
    if (!certificate?.raw) {
      this.verifyWithoutPeerCertificate(socket);
      return;
    }
    this.tlsVerificationStarted = true;
    try {
      this.tlsVerification = this.host.acceptPeerFingerprint(certificate.raw)
        .then(() => this.markTlsVerified())
        .catch((error: unknown) => {
          this.fail(error, 'connect');
        });
    } catch (error) {
      this.fail(error, 'connect');
    }
  }

  private verifyWithoutPeerCertificate(socket: ActiveSocket): void {
    const { serverFingerprint, tlsOptions } = this.host;
    if (socket.secureConnecting === true) {
      this.waitForSecureConnect(socket);
      return;
    }
    if (socket.authorized === true && serverFingerprint) {
      this.tlsVerificationStarted = true;
      try {
        if (
          tlsOptions.expectedFingerprint &&
          serverFingerprint !== normalizeCertificateFingerprint(tlsOptions.expectedFingerprint)
        ) {
          throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
        }
        this.tlsVerification = Promise.resolve().then(() => this.markTlsVerified());
      } catch (error) {
        this.fail(error, 'connect');
      }
      return;
    }
    this.fail(new IncusError('TLS_ERROR', 'retry', { phase: 'connect' }), 'connect');
  }
}

export function sendExchange(
  host: ExchangeHost,
  requestOptions: RequestOptions,
  body: Buffer | undefined,
  options: IncusRequestOptions,
  path: string,
  requestDeadlineMs: number,
): Promise<ExchangeResult> {
  return new Exchange(host, requestOptions, body, options, path, requestDeadlineMs).run();
}
