import * as http from 'node:http';
import * as https from 'node:https';
import { hostname } from 'node:os';
import { zAgentEnrollResponse, type AgentEnrollResponse } from '@nyabase/common';
import { enrollUrl, type AgentConfig } from './config.js';

const ENROLL_TIMEOUT_MS = 15_000;
const MAX_ENROLL_RESPONSE_BYTES = 64 * 1024;

/** A rejection the agent cannot fix by retrying (bad, used or expired token). */
export class EnrollmentRejectedError extends Error {}

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
        if (status >= 400 && status < 500) {
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
