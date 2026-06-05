/**
 * IP / CIDR helpers and small utilities shared across packages.
 *
 * All public helpers validate their inputs and throw on malformed values
 * rather than silently propagating NaN.
 */

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;

/** Convert an IPv4 string to a 32-bit unsigned integer. Throws on invalid input. */
export function ipToNum(ip: string): number {
  const m = IPV4_REGEX.exec(ip);
  if (!m) throw new Error(`Invalid IPv4 address: ${ip}`);
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const oct = Number(m[i]);
    if (oct < 0 || oct > 255) throw new Error(`Invalid IPv4 octet in ${ip}`);
    n = (n << 8) + oct;
  }
  return n >>> 0;
}

/** Convert a 32-bit unsigned integer back to an IPv4 string. */
export function numToIp(num: number): string {
  if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) {
    throw new Error(`Invalid IPv4 number: ${num}`);
  }
  return [
    (num >>> 24) & 0xff,
    (num >>> 16) & 0xff,
    (num >>> 8) & 0xff,
    num & 0xff,
  ].join('.');
}

/** Parse a CIDR string into a [baseIp, prefixLen] tuple; throws on invalid input. */
export function parseCidr(cidr: string): { base: string; prefixLen: number } {
  const m = CIDR_REGEX.exec(cidr);
  if (!m) throw new Error(`Invalid CIDR: ${cidr}`);
  const prefixLen = Number(m[2]);
  if (prefixLen < 0 || prefixLen > 32) {
    throw new Error(`Invalid CIDR prefix length: ${cidr}`);
  }
  ipToNum(m[1]); // validate base
  return { base: m[1], prefixLen };
}

/**
 * Convert CIDR to sorted list of usable host IPs
 * (excludes network addr, broadcast, and given reservations).
 * Returns [] for /31 and /32.
 */
export function cidrToIps(cidr: string, reservedIps: string[] = []): string[] {
  const { base, prefixLen } = parseCidr(cidr);
  const baseNum = ipToNum(base);
  const hostBits = 32 - prefixLen;
  if (hostBits <= 1) return [];

  const networkAddr = (baseNum & ((~0 << hostBits) >>> 0)) >>> 0;
  const broadcastAddr = (networkAddr | ((1 << hostBits) - 1)) >>> 0;

  // Validate reservations once (ignore malformed entries to avoid breaking
  // unrelated callers, but require well-formed CIDR base).
  const reserved = new Set<string>();
  for (const ip of reservedIps) {
    if (IPV4_REGEX.test(ip)) reserved.add(ip);
  }

  const ips: string[] = [];
  for (let n = networkAddr + 1; n < broadcastAddr; n++) {
    const ip = numToIp(n);
    if (!reserved.has(ip)) ips.push(ip);
  }
  return ips;
}

/** Find the first IP in the CIDR (ordered) not in usedIps set */
export function allocateNextIp(
  cidr: string,
  usedIps: Set<string>,
  reservedIps: string[] = [],
): string | null {
  for (const ip of cidrToIps(cidr, reservedIps)) {
    if (!usedIps.has(ip)) return ip;
  }
  return null;
}

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/** Format bytes to a human-readable string. Non-finite or negative input → '0 B'. */
export function formatBytes(bytes: number, decimals = 2): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const k = 1024;
  const i = Math.min(
    BYTE_UNITS.length - 1,
    Math.floor(Math.log(bytes) / Math.log(k)),
  );
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(decimals))} ${BYTE_UNITS[i]}`;
}

/**
 * Generate a cryptographically secure random hex token.
 * Works in both Node.js and browsers (Web Crypto).
 *
 * @param byteLength Number of random bytes (output string length = byteLength * 2)
 */
export function generateToken(byteLength = 16): string {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new Error(`generateToken: byteLength must be a positive integer`);
  }
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}
