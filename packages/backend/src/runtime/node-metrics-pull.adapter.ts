import { createHash, createDecipheriv } from 'node:crypto';
import {
  checkServerIdentity as tlsCheckServerIdentity,
  type PeerCertificate,
  type TLSSocket,
} from 'node:tls';
import { request } from 'node:https';
import { Inject, Injectable } from '@nestjs/common';
import {
  MAX_NODE_METRICS_BODY_BYTES,
  NODE_METRICS_CONNECT_TIMEOUT_MS,
  NODE_METRICS_ENDPOINT_PATH,
  NODE_METRICS_PARSE_TIMEOUT_MS,
  NODE_METRICS_REQUEST_TIMEOUT_MS,
  NODE_METRICS_RESPONSE_HEADER_TIMEOUT_MS,
  parseOpenMetrics,
  type NodeMetricSample,
} from '@nyabase/common';
import type { Kysely } from 'kysely';
import type { NyabaseDatabase } from '../persistence-pg/database.types.js';
import { PG_DATABASE } from '../persistence-pg/tokens.js';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import {
  leafCertificateFingerprint,
  normalizeCertificateFingerprint,
} from '../incus/index.js';
import type {
  NodeMetricsPullPort,
} from './server-preflight-reconciler.service.js';

const ENCRYPTED_SECRET_VERSION = 'rfs-v1';

export type NodeMetricsPullFailureCode =
  | 'NODE_METRICS_UNCONFIGURED'
  | 'NODE_METRICS_INVALID_ENDPOINT'
  | 'NODE_METRICS_UNAUTHORIZED'
  | 'NODE_METRICS_UNREACHABLE'
  | 'NODE_METRICS_INVALID_RESPONSE'
  | 'NODE_METRICS_TLS_PIN_MISMATCH';

export class NodeMetricsPullError extends Error {
  readonly code: NodeMetricsPullFailureCode;

  constructor(code: NodeMetricsPullFailureCode, message: string) {
    super(message);
    this.name = 'NodeMetricsPullError';
    this.code = code;
  }
}

@Injectable()
export class AuthenticatedNodeMetricsPullAdapter implements NodeMetricsPullPort {
  constructor(
    @Inject(PG_DATABASE) private readonly database: Kysely<NyabaseDatabase>,
    private readonly config: NyabaseConfigService,
  ) {}

  async pull(
    serverId: string,
    endpoint: string,
    tokenCiphertext: string | null,
    signal?: AbortSignal,
  ): Promise<{
    readonly status: 'online' | 'unreachable' | 'unknown';
    readonly report: NodeMetricsPullReport;
  }> {
    if (!tokenCiphertext) {
      throw new NodeMetricsPullError(
        'NODE_METRICS_UNCONFIGURED',
        'Node metrics authentication is not configured',
      );
    }
    const url = parseEndpoint(endpoint);
    const expectedFingerprint = await this.database
      .selectFrom('infra.servers')
      .select('node_metrics_server_cert_fingerprint')
      .where('id', '=', serverId)
      .executeTakeFirst()
      .then((row) => row?.node_metrics_server_cert_fingerprint ?? null);
    const normalizedExpectedFingerprint = normalizePinnedFingerprint(expectedFingerprint);
    const token = decryptSecret(tokenCiphertext, this.config);
    const body = await this.fetch(url, token, normalizedExpectedFingerprint, signal);
    const samples = parseMetrics(body);
    return {
      status: 'online',
      report: {
        endpoint: url.toString(),
        contentType: 'text/plain',
        sampleCount: samples.length,
        samples,
        metrics: firstMetricValues(samples),
      },
    };
  }

  private fetch(
    url: URL,
    token: string,
    expectedFingerprint: string,
    signal?: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let totalTimer: NodeJS.Timeout | undefined;
      let headerTimer: NodeJS.Timeout | undefined;
      const finish = (error: Error | null, value?: string): void => {
        if (settled) return;
        settled = true;
        if (totalTimer) clearTimeout(totalTimer);
        if (headerTimer) clearTimeout(headerTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (error) reject(error);
        else resolve(value ?? '');
      };
      const fail = (error: NodeMetricsPullError): void => {
        requestHandle.destroy(error);
        finish(error);
      };
      const onAbort = (): void => {
        fail(new NodeMetricsPullError(
          'NODE_METRICS_UNREACHABLE',
          'Node metrics request was aborted',
        ));
      };
      const requestHandle = request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: NODE_METRICS_ENDPOINT_PATH,
        method: 'GET',
        agent: false,
        rejectUnauthorized: false,
        headers: {
          Accept: 'text/plain; version=0.0.4',
          Authorization: `Bearer ${token}`,
          'User-Agent': 'nyabase-node-metrics/1',
        },
        timeout: NODE_METRICS_REQUEST_TIMEOUT_MS,
        checkServerIdentity: (host, certificate: PeerCertificate) => {
          const hostnameError = tlsCheckServerIdentity(host, certificate);
          if (hostnameError) return hostnameError;
          if (
            !certificate.raw
            || leafCertificateFingerprint(certificate.raw) !== expectedFingerprint
          ) {
            return new NodeMetricsPullError(
              'NODE_METRICS_TLS_PIN_MISMATCH',
              'Node metrics certificate did not match its pin',
            );
          }
          return undefined;
        },
      }, (response) => {
        if (headerTimer) clearTimeout(headerTimer);
        const contentType = response.headers['content-type'];
        if (
          typeof contentType !== 'string'
          || !/^text\/plain(?:;|$)/i.test(contentType.trim())
        ) {
          fail(new NodeMetricsPullError(
            'NODE_METRICS_INVALID_RESPONSE',
            'Node metrics endpoint returned an unsupported content type',
          ));
          return;
        }
        const peer = response.socket as TLSSocket | null;
        const certificate = peer?.getPeerCertificate(true);
        if (!certificate?.raw || leafCertificateFingerprint(certificate.raw) !== expectedFingerprint) {
          fail(new NodeMetricsPullError(
            'NODE_METRICS_TLS_PIN_MISMATCH',
            'Node metrics certificate did not match its pin',
          ));
          return;
        }
        const status = response.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.byteLength;
          if (bytes > MAX_NODE_METRICS_BODY_BYTES) {
            fail(new NodeMetricsPullError(
              'NODE_METRICS_INVALID_RESPONSE',
              'Node metrics response exceeded the maximum size',
            ));
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (status === 401 || status === 403) {
            finish(new NodeMetricsPullError(
              'NODE_METRICS_UNAUTHORIZED',
              `Node metrics endpoint returned HTTP ${status}`,
            ));
            return;
          }
          if (status < 200 || status >= 300) {
            finish(new NodeMetricsPullError(
              status >= 500
                ? 'NODE_METRICS_UNREACHABLE'
                : 'NODE_METRICS_INVALID_RESPONSE',
              `Node metrics endpoint returned HTTP ${status}`,
            ));
            return;
          }
          finish(null, text);
        });
        response.on('error', (error) => {
          finish(new NodeMetricsPullError(
            'NODE_METRICS_UNREACHABLE',
            error.message,
          ));
        });
      });
      requestHandle.on('socket', (socket) => {
        const connectTimer = setTimeout(() => {
          fail(new NodeMetricsPullError(
            'NODE_METRICS_UNREACHABLE',
            'Node metrics connection timed out',
          ));
        }, NODE_METRICS_CONNECT_TIMEOUT_MS);
        const clearConnectTimer = (): void => clearTimeout(connectTimer);
        socket.once('connect', clearConnectTimer);
        socket.once('secureConnect', clearConnectTimer);
        socket.once('close', clearConnectTimer);
        headerTimer = setTimeout(() => {
          fail(new NodeMetricsPullError(
            'NODE_METRICS_UNREACHABLE',
            'Node metrics response headers timed out',
          ));
        }, NODE_METRICS_RESPONSE_HEADER_TIMEOUT_MS);
      });
      totalTimer = setTimeout(() => {
        fail(new NodeMetricsPullError(
          'NODE_METRICS_UNREACHABLE',
          'Node metrics request timed out',
        ));
      }, NODE_METRICS_REQUEST_TIMEOUT_MS);
      totalTimer.unref?.();
      requestHandle.on('timeout', () => {
        fail(new NodeMetricsPullError(
          'NODE_METRICS_UNREACHABLE',
          'Node metrics request timed out',
        ));
      });
      requestHandle.on('error', (error: Error) => {
        if (error instanceof NodeMetricsPullError) finish(error);
        else finish(new NodeMetricsPullError('NODE_METRICS_UNREACHABLE', error.message));
      });
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      requestHandle.end();
    });
  }
}

export interface NodeMetricsPullReport {
  readonly [key: string]: unknown;
  readonly endpoint: string;
  readonly contentType: string;
  readonly sampleCount: number;
  readonly samples: readonly NodeMetricSample[];
  readonly metrics: Readonly<Record<string, number>>;
}

export function parseEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new NodeMetricsPullError(
      'NODE_METRICS_INVALID_ENDPOINT',
      'Node metrics endpoint is not a valid URL',
    );
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== NODE_METRICS_ENDPOINT_PATH
    || url.search
    || url.hash
  ) {
    throw new NodeMetricsPullError(
      'NODE_METRICS_INVALID_ENDPOINT',
      'Node metrics endpoint must be fixed HTTPS /metrics without credentials or query',
    );
  }
  return url;
}

function normalizePinnedFingerprint(value: string | null): string {
  if (!value) {
    throw new NodeMetricsPullError(
      'NODE_METRICS_TLS_PIN_MISMATCH',
      'Node metrics certificate pin is not configured',
    );
  }
  try {
    return normalizeCertificateFingerprint(value);
  } catch {
    throw new NodeMetricsPullError(
      'NODE_METRICS_TLS_PIN_MISMATCH',
      'Node metrics certificate pin is malformed',
    );
  }
}

function parseMetrics(body: string): NodeMetricSample[] {
  try {
    const startedAt = Date.now();
    const samples = parseOpenMetrics(body);
    if (Date.now() - startedAt > NODE_METRICS_PARSE_TIMEOUT_MS) {
      throw new Error('OpenMetrics parsing exceeded its time budget');
    }
    return samples;
  } catch {
    throw new NodeMetricsPullError(
      'NODE_METRICS_INVALID_RESPONSE',
      'Node metrics response failed the allowlisted OpenMetrics schema',
    );
  }
}

function firstMetricValues(samples: readonly NodeMetricSample[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const sample of samples) {
    if (metrics[sample.name] === undefined) metrics[sample.name] = sample.value;
  }
  return metrics;
}

function decryptSecret(value: string, config: NyabaseConfigService): string {
  if (!value.startsWith(`${ENCRYPTED_SECRET_VERSION}.`)) {
    throw new NodeMetricsPullError(
      'NODE_METRICS_UNCONFIGURED',
      'Node metrics token ciphertext is malformed',
    );
  }
  const parts = value.split('.');
  if (parts.length !== 4) {
    throw new NodeMetricsPullError(
      'NODE_METRICS_UNCONFIGURED',
      'Node metrics token ciphertext is malformed',
    );
  }
  try {
    const secret = config.keyEncryptionSecret();
    const key = createHash('sha256').update(secret).digest();
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(parts[1], 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(parts[2], 'base64url'));
    const token = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final(),
    ]).toString('utf8');
    if (
      token.length === 0
      || token.length > 1024
      || /[\u0000-\u001f\u007f\s]/.test(token)
    ) {
      throw new Error('invalid token');
    }
    return token;
  } catch {
    throw new NodeMetricsPullError(
      'NODE_METRICS_UNCONFIGURED',
      'Node metrics token ciphertext could not be decrypted',
    );
  }
}
