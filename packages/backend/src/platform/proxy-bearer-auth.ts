import { createHash, timingSafeEqual } from 'crypto';
import type { IncomingMessage } from 'http';

const MIN_PROXY_TOKEN_BYTES = 32;
const MAX_PROXY_TOKEN_BYTES = 1024;
const PROXY_TOKEN_RE = /^[A-Za-z0-9_-]{32,1024}$/;

export function configuredProxyTokenDigest(token: string, configKey: string): Buffer {
  const bytes = Buffer.byteLength(token);
  if (
    bytes < MIN_PROXY_TOKEN_BYTES
    || bytes > MAX_PROXY_TOKEN_BYTES
    || !PROXY_TOKEN_RE.test(token)
  ) {
    throw new Error(
      `${configKey} must be an explicit ${MIN_PROXY_TOKEN_BYTES}-${MAX_PROXY_TOKEN_BYTES} character ASCII token using only letters, digits, _ or -`,
    );
  }
  return digest(token);
}

export function hasValidBearerToken(req: IncomingMessage, expectedDigest: Buffer): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const match = /^Bearer ([A-Za-z0-9_-]{32,1024})$/.exec(header);
  if (!match) return false;
  return timingSafeEqual(digest(match[1]), expectedDigest);
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
