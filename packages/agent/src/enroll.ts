import * as http from 'node:http';
import * as https from 'node:https';
import { hostname } from 'node:os';
import { zAgentEnrollResponse, type AgentEnrollResponse } from '@nyabase/common';
import { enrollUrl, type AgentConfig } from './config.js';

const ENROLL_TIMEOUT_MS = 15_000;
const MAX_ENROLL_RESPONSE_BYTES = 64 * 1024;
const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

/** A rejection the agent cannot fix by retrying (bad, spent or expired token). */
export class EnrollmentRejectedError extends Error {}

/** Throttling and request timeouts are 4xx too, but retrying fixes them. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500 || status < 200;
}

export interface EnrollRetryOptions {
  readonly exchange: (enrollmentToken: string) => Promise<AgentEnrollResponse>;
  readonly store: { write(credential: string): Promise<void> };
  readonly log: (message: string) => void;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
}

/**
 * Exchange the enrollment token and persist the credential, retrying any
 * transient failure (transport, timeout, throttling, 5xx, a failed write)
 * with capped, jittered backoff. The Backend keeps the token usable until the
 * agent first authenticates with the credential it got, so a retry after a
 * lost response or a failed write succeeds; only a real rejection is final.
 */
export async function enrollUntilAccepted(
  enrollmentToken: string,
  signal: AbortSignal,
  options: EnrollRetryOptions,
): Promise<string> {
  const maxDelay = options.maxDelayMs ?? RETRY_MAX_MS;
  let delay = options.initialDelayMs ?? RETRY_INITIAL_MS;
  while (!signal.aborted) {
    try {
      const result = await options.exchange(enrollmentToken);
      await options.store.write(result.credential);
      options.log(`enrolled as server ${result.serverId}`);
      return result.credential;
    } catch (error) {
      if (error instanceof EnrollmentRejectedError) throw error;
      const wait = delay / 2 + Math.random() * (delay / 2);
      options.log(`enrollment failed, retrying in ${Math.round(wait / 1000)}s: ${
        error instanceof Error ? error.message : String(error)}`);
      await abortableSleep(wait, signal);
      delay = Math.min(maxDelay, delay * 2);
    }
  }
  throw new Error('stopped before enrollment completed');
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Exchange the one-time enrollment token for the agent's long-lived credential. */
export function enroll(
  config: Pick<AgentConfig, 'backendUrl' | 'backendCa'>,
  enrollmentToken: string,
): Promise<AgentEnrollResponse> {
  const url = enrollUrl(config);
  const body = Buffer.from(JSON.stringify({ enrollmentToken, hostname: hostname() }));
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const request = transport.request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(body.byteLength),
      },
      timeout: ENROLL_TIMEOUT_MS,
      ...(url.protocol === 'https:' && config.backendCa ? { ca: config.backendCa } : {}),
    }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > MAX_ENROLL_RESPONSE_BYTES) {
          request.destroy(new Error('Enrollment response is too large'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        const text = Buffer.concat(chunks).toString('utf8');
        if (status >= 400 && !isTransientStatus(status)) {
          reject(new EnrollmentRejectedError(`Enrollment rejected (${status}): ${text.slice(0, 256)}`));
          return;
        }
        if (status < 200 || status >= 300) {
          reject(new Error(`Enrollment failed (${status})`));
          return;
        }
        try {
          resolve(zAgentEnrollResponse.parse(JSON.parse(text)));
        } catch {
          reject(new Error('Enrollment response is malformed'));
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Enrollment request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}
