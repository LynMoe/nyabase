import * as https from 'node:https';
import { checkServerIdentity } from 'node:tls';
import type { RequestOptions } from 'node:https';
import WebSocket, { type ClientOptions as WebSocketClientOptions } from 'ws';
import {
  IncusError,
  mapIncusTransportError,
  normalizeCertificateFingerprint,
} from './incus-errors.js';
import type {
  IncusClientOptions,
  IncusFileResponse,
  IncusHttpMethod,
  IncusRequestFactory,
  IncusRequestOptions,
  IncusResponse,
  IncusTimeouts,
  IncusTlsOptions,
  IncusWebSocketFactory,
  IncusWebSocketLike,
} from './incus-client-types.js';
import { sendExchange, type ExchangeHost, type ExchangeResult } from './incus-http-exchange.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_TIMEOUTS,
  assertHeaderValue,
  assertLeafCertificateFingerprint,
  boundedTimeout,
  leafCertificateFingerprint,
  mutableCa,
  normalizeTimeouts,
} from './incus-request-util.js';

/**
 * Connection handling shared by every Incus endpoint: endpoint allow-listing,
 * mTLS with leaf-fingerprint pinning (trust on first use), request execution
 * and websocket dialing.
 */
export class IncusTransport implements ExchangeHost {
  readonly endpoint: string;

  protected readonly baseUrl: URL;
  readonly tlsOptions: IncusTlsOptions;
  protected readonly allowedHosts: ReadonlySet<string>;
  readonly timeouts: IncusTimeouts;
  protected readonly operationWaitTimeoutMs: number;
  readonly maxBodyBytes: number;
  readonly requestFactory: IncusRequestFactory;
  protected readonly websocketFactory: IncusWebSocketFactory;
  serverFingerprint?: string;
  private firstFingerprintPromise?: Promise<void>;


  constructor(options: IncusClientOptions) {
    this.baseUrl = this.validateEndpoint(options.endpoint, options.allowedHosts);
    this.endpoint = this.baseUrl.origin;
    this.allowedHosts = new Set(options.allowedHosts.map((host) => host.toLowerCase()));
    this.tlsOptions = options.tls;
    this.timeouts = normalizeTimeouts(options.timeouts);
    this.operationWaitTimeoutMs = boundedTimeout(
      options.operationWaitTimeoutMs,
      DEFAULT_TIMEOUTS.totalMs,
    );
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (
      !Number.isSafeInteger(this.maxBodyBytes) ||
      this.maxBodyBytes <= 0 ||
      this.maxBodyBytes > 128 * 1024 * 1024
    ) {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'body_limit',
      });
    }
    if (!options.tls.cert || !options.tls.key) {
      throw new IncusError('TLS_ERROR', 'managed_failure');
    }
    if (options.tls.fingerprint) {
      this.serverFingerprint = normalizeCertificateFingerprint(options.tls.fingerprint);
    }
    if (!this.serverFingerprint && !options.tls.onFirstFingerprint) {
      throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
    }
    this.requestFactory =
      options.requestFactory ??
      ((requestOptions, callback) => https.request(requestOptions, callback));
    this.websocketFactory =
      options.websocketFactory ?? ((url, websocketOptions) => new WebSocket(url, websocketOptions));
  }

  get pinnedFingerprint(): string | undefined {
    return this.serverFingerprint;
  }

  async requestJson<T>(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusResponse<T>> {
    const response = await this.executeRequest(method, path, options);
    if (response.kind !== 'json') {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'expected_json',
      });
    }
    return response.value as IncusResponse<T>;
  }

  async requestRaw(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions = {},
  ): Promise<IncusFileResponse> {
    const response = await this.executeRequest(method, path, {
      ...options,
      responseType: 'raw',
    });
    if (response.kind !== 'raw') {
      throw new IncusError('INCUS_INVALID_RESPONSE', 'managed_failure', {
        reason: 'expected_raw',
      });
    }
    return response.value;
  }

  protected tlsPin(): string | undefined {
    return this.serverFingerprint ?? this.tlsOptions.expectedFingerprint;
  }

  protected pinnedTlsSocketOptions(): {
    readonly ca: string | Buffer | Array<string | Buffer> | undefined;
    readonly rejectUnauthorized: boolean;
  } {
    // Multi-server Incus deployments each have their own self-signed leaf.
    // The control-plane bootstrap CA only matches the first host; once a leaf
    // fingerprint pin is present, disable CA rejection and enforce the pin in
    // checkServerIdentity / acceptPeerFingerprint instead.
    if (this.tlsPin()) {
      return { ca: undefined, rejectUnauthorized: false };
    }
    return {
      ca: mutableCa(this.tlsOptions.ca),
      rejectUnauthorized: true,
    };
  }

  async dialWebSocket(path: string, signal?: AbortSignal): Promise<IncusWebSocketLike> {
    const url = this.urlForPath(path);
    url.protocol = 'wss:';
    let peerFingerprintRaw: Buffer | undefined;
    const pinned = this.pinnedTlsSocketOptions();

    const websocketOptions: WebSocketClientOptions = {
      cert: this.tlsOptions.cert,
      key: this.tlsOptions.key,
      ca: pinned.ca,
      rejectUnauthorized: pinned.rejectUnauthorized,
      checkServerIdentity: ((hostname: string, certificate: unknown) => {
        const peerCertificate = certificate as Parameters<typeof checkServerIdentity>[1];
        if (!peerCertificate.raw) {
          return new Error('Incus TLS peer certificate is unavailable');
        }
        peerFingerprintRaw = peerCertificate.raw;
        // Fingerprint-pin mode is authoritative for Incus mTLS. Remote Incus
        // leaves often omit the LAN listen IP from SAN (only 127.0.0.1), so a
        // hostname check would reject a correctly pinned server certificate.
        const pin = this.tlsPin();
        if (pin) {
          try {
            assertLeafCertificateFingerprint(peerCertificate.raw, pin);
            return undefined;
          } catch {
            return new Error('Incus TLS certificate pin mismatch');
          }
        }
        return checkServerIdentity(hostname, peerCertificate);
      }) as unknown as NonNullable<WebSocketClientOptions['checkServerIdentity']>,
    };

    return new Promise<IncusWebSocketLike>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let socket: IncusWebSocketLike | undefined;
      const cleanup = (): void => {
        signal?.removeEventListener('abort', abort);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        socket?.close();
        reject(error instanceof IncusError ? error : mapIncusTransportError(error, 'connect'));
      };
      const abort = (): void => {
        if (settled) {
          socket?.close(1000, 'aborted');
          socket?.terminate?.();
          return;
        }
        fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'connect' }));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        fail(new IncusError('INCUS_TIMEOUT', 'retry', { phase: 'connect' }));
      }, this.timeouts.totalMs);
      try {
        socket = this.websocketFactory(url.toString(), websocketOptions);
        socket.once('open', () => {
          if (settled) return;
          void (async () => {
            if (!this.serverFingerprint) {
              if (!peerFingerprintRaw) {
                throw new IncusError('TLS_ERROR', 'retry', { phase: 'connect' });
              }
              await this.acceptPeerFingerprint(peerFingerprintRaw);
            }
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            cleanup();
            resolve(socket as IncusWebSocketLike);
          })().catch((error: unknown) => fail(error));
        });
        socket.once('close', () => {
          cleanup();
        });
        socket.once('error', (error: unknown) => fail(error));
        socket.once('close', () => {
          if (!settled) {
            fail(new Error('Incus websocket closed during connect'));
          }
        });
      } catch (error) {
        fail(error);
      }
    });
  }

  protected validateEndpoint(endpoint: string, allowedHosts: readonly string[]): URL {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure');
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '' && url.pathname !== '/')
    ) {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure');
    }
    const allowed = new Set(allowedHosts.map((host) => host.toLowerCase()));
    if (allowed.size === 0 || !allowed.has(url.hostname.toLowerCase())) {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure', {
        reason: 'host_not_allowlisted',
      });
    }
    return url;
  }

  protected urlForPath(path: string): URL {
    const rawPath = path.split(/[?#]/, 1)[0];
    if (
      !path.startsWith('/') ||
      path.startsWith('//') ||
      /[\u0000-\u001f\u007f]/.test(path) ||
      /%2e|%5c/i.test(rawPath)
    ) {
      throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', { reason: 'path' });
    }
    const url = new URL(path, this.baseUrl);
    if (
      url.origin !== this.baseUrl.origin ||
      !this.allowedHosts.has(url.hostname.toLowerCase()) ||
      (url.pathname !== '/1.0' && !url.pathname.startsWith('/1.0/'))
    ) {
      throw new IncusError('INVALID_ENDPOINT', 'managed_failure');
    }
    return url;
  }

  acceptPeerFingerprint(raw: Buffer): Promise<void> {
    const actualFingerprint = leafCertificateFingerprint(raw);
    const expectedFingerprint = this.tlsOptions.expectedFingerprint;
    if (
      expectedFingerprint &&
      actualFingerprint !== normalizeCertificateFingerprint(expectedFingerprint)
    ) {
      return Promise.reject(new IncusError('TLS_PIN_MISMATCH', 'managed_failure'));
    }
    if (this.serverFingerprint) {
      assertLeafCertificateFingerprint(raw, this.serverFingerprint);
      return Promise.resolve();
    }
    if (!this.tlsOptions.onFirstFingerprint) {
      return Promise.reject(new IncusError('TLS_PIN_MISMATCH', 'managed_failure'));
    }
    if (!this.firstFingerprintPromise) {
      const acceptance = Promise.resolve()
        .then(() => this.tlsOptions.onFirstFingerprint?.(actualFingerprint))
        .then(() => {
          this.serverFingerprint = actualFingerprint;
        });
      this.firstFingerprintPromise = acceptance.catch((error: unknown) => {
        this.firstFingerprintPromise = undefined;
        throw error;
      });
    }
    return this.firstFingerprintPromise.then(() => {
      if (this.serverFingerprint !== actualFingerprint) {
        throw new IncusError('TLS_PIN_MISMATCH', 'managed_failure');
      }
    });
  }

  /** Execute one HTTPS request and return the parsed JSON or raw response. */
  protected executeRequest(
    method: IncusHttpMethod,
    path: string,
    options: IncusRequestOptions,
  ): Promise<ExchangeResult> {
    const url = this.urlForPath(path);
    const headers: Record<string, string> = {
      accept: options.responseType === 'raw' ? '*/*' : 'application/json',
      ...options.headers,
    };
    for (const [name, value] of Object.entries(headers)) {
      assertHeaderValue(value, name);
    }
    if (options.ifMatch !== undefined) {
      assertHeaderValue(options.ifMatch, 'if-match');
      headers['If-Match'] = options.ifMatch;
    }
    const body = this.encodeBody(options, headers);
    const requestOptions = this.requestOptionsFor(method, url, headers);
    const requestDeadlineMs = boundedTimeout(options.timeoutMs, this.timeouts.totalMs);
    return sendExchange(this, requestOptions, body, options, path, requestDeadlineMs);
  }

  /** The serialized request body, with content headers set; refuses oversized or unserializable bodies. */
  private encodeBody(
    options: IncusRequestOptions,
    headers: Record<string, string>,
  ): Buffer | undefined {
    if (options.body === undefined) return undefined;
    let body: Buffer;
    if (Buffer.isBuffer(options.body)) {
      body = options.body;
    } else {
      try {
        body = Buffer.from(JSON.stringify(options.body));
      } catch {
        throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
          reason: 'body_not_serializable',
        });
      }
      headers['content-type'] ??= 'application/json';
    }
    headers['content-length'] = String(body.byteLength);
    if (body.byteLength > this.maxBodyBytes) {
      throw new IncusError('INCUS_BAD_REQUEST', 'managed_failure', {
        reason: 'request_body_too_large',
      });
    }
    return body;
  }

  private requestOptionsFor(
    method: IncusHttpMethod,
    url: URL,
    headers: Record<string, string>,
  ): RequestOptions {
    const pinned = this.pinnedTlsSocketOptions();
    return {
      protocol: 'https:',
      hostname: url.hostname,
      port: url.port ? Number(url.port) : 443,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      cert: this.tlsOptions.cert,
      key: this.tlsOptions.key,
      ca: pinned.ca,
      rejectUnauthorized: pinned.rejectUnauthorized,
      servername: url.hostname,
      checkServerIdentity: (hostname, certificate) => {
        // Prefer the leaf fingerprint pin over hostname/SAN matching. Incus
        // server certs commonly list only 127.0.0.1 even when core.https_address
        // is a LAN IP; connect/onboarding still pins the expected leaf.
        const pin = this.tlsPin();
        if (pin) {
          try {
            if (!certificate.raw) {
              return new Error('Incus TLS peer certificate is unavailable');
            }
            assertLeafCertificateFingerprint(certificate.raw, pin);
            return undefined;
          } catch {
            return new Error('Incus TLS certificate pin mismatch');
          }
        }
        return checkServerIdentity(hostname, certificate);
      },
    };
  }
}
