import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';

export async function fetchAuthenticatedMetrics(
  endpoint: string,
  token: string,
  options: {
    caFile?: string;
    expectedServerCertFingerprint?: string;
  } = {},
): Promise<{ status: number; body: string }> {
  const url = new URL(endpoint);
  if (url.protocol !== 'https:') {
    throw new Error('Node exporter endpoint must use HTTPS');
  }
  const expected = normalizeFingerprint(options.expectedServerCertFingerprint);
  const ca = options.caFile ? readFileSync(options.caFile) : undefined;
  return new Promise((resolve, reject) => {
    const responseRequest = request(url, {
      method: 'GET',
      ca,
      rejectUnauthorized: true,
      checkServerIdentity: (hostname, certificate) => {
        const tlsError = checkServerIdentity(hostname, certificate);
        if (tlsError) return tlsError;
        if (expected && normalizeFingerprint(certificate.fingerprint256) !== expected) {
          return new Error('Node exporter certificate fingerprint mismatch');
        }
        return undefined;
      },
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'text/plain; version=0.0.4',
      },
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolve({
        status: response.statusCode ?? 500,
        body,
      }));
    });
    responseRequest.on('error', reject);
    responseRequest.end();
  });
}

export function assertMetricFamily(body: string, family: string): void {
  const matcher = new RegExp(`^${escapeRegExp(family)}(?:\\{|\\s)`, 'm');
  if (!matcher.test(body)) {
    throw new Error(`Authenticated metrics response is missing ${family}`);
  }
}

function normalizeFingerprint(value: string | undefined): string {
  return String(value ?? '').replace(/[:-\s]/g, '').toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
