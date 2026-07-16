/**
 * IP / CIDR helpers and small utilities shared across packages.
 *
 * All public helpers validate their inputs and throw on malformed values
 * rather than silently propagating NaN.
 */

const IPV4_REGEX = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const CIDR_REGEX = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/;
const MAX_MATERIALIZED_CIDR_HOSTS = 65_534;

/**
 * Canonicalize the deliberately small Docker reference grammar accepted by
 * nyabase. Every stored image has an explicit tag and an
 * explicit registry, so aliases such as `ubuntu`, `ubuntu:latest`, and
 * `docker.io/library/ubuntu:latest` cannot acquire separate logical owners.
 */
export function normalizeDockerImageRef(input: string): string {
  const value = input.trim();
  if (value.length === 0 || value.length > 512 || /\s|:\/\//.test(value)) {
    throw new Error('Docker image reference must be a non-empty registry/repository:tag');
  }
  if (value.includes('@')) {
    throw new Error('Docker image digests are not supported; use one explicit immutable tag');
  }
  const slash = value.lastIndexOf('/');
  const colon = value.lastIndexOf(':');
  if (colon <= slash || colon === value.length - 1) {
    throw new Error('Docker image reference must include an explicit tag');
  }
  const tag = value.slice(colon + 1);
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)) {
    throw new Error('Docker image tag is invalid');
  }
  const name = value.slice(0, colon);
  const suffix = `:${tag}`;

  const segments = name.toLowerCase().split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error('Docker image repository contains an empty path segment');
  }
  const first = segments[0]!;
  const hasRegistry = segments.length > 1
    && (first === 'localhost' || first.includes('.') || first.includes(':'));
  let registry = hasRegistry ? segments.shift()! : 'docker.io';
  if (registry === 'index.docker.io') registry = 'docker.io';
  if (!/^(?:localhost|[a-z0-9.-]+)(?::[0-9]{1,5})?$/.test(registry)) {
    throw new Error('Docker image registry is invalid');
  }
  if (registry === 'docker.io' && segments.length === 1) segments.unshift('library');
  if (segments.some((segment) => !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(segment))) {
    throw new Error('Docker image repository is invalid');
  }
  return `${registry}/${segments.join('/')}${suffix}`;
}

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

/** Return the unique textual representation of an IPv4 address. */
export function canonicalIpv4Address(ip: string): string {
  return numToIp(ipToNum(ip));
}

/** Return the unique network-base representation of an IPv4 CIDR. */
export function canonicalIpv4Cidr(cidr: string): string {
  const { base, prefixLen } = parseCidr(cidr);
  const { networkAddr } = cidrBounds(base, prefixLen);
  return `${numToIp(networkAddr)}/${prefixLen}`;
}

/** True when two IPv4 CIDRs cover at least one same address. */
export function ipv4CidrsOverlap(left: string, right: string): boolean {
  const leftParsed = parseCidr(left);
  const rightParsed = parseCidr(right);
  const leftBounds = cidrBounds(leftParsed.base, leftParsed.prefixLen);
  const rightBounds = cidrBounds(rightParsed.base, rightParsed.prefixLen);
  return leftBounds.networkAddr <= rightBounds.broadcastAddr
    && rightBounds.networkAddr <= leftBounds.broadcastAddr;
}

/**
 * Convert CIDR to sorted list of usable host IPs
 * (excludes network addr, broadcast, and given reservations).
 * Returns [] for /31 and /32.
 */
export function cidrToIps(cidr: string, reservedIps: string[] = []): string[] {
  const { base, prefixLen } = parseCidr(cidr);
  const { networkAddr, broadcastAddr, usableHosts } = cidrBounds(base, prefixLen);
  if (usableHosts === 0) return [];
  if (usableHosts > MAX_MATERIALIZED_CIDR_HOSTS) {
    throw new Error(`CIDR is too large to materialize safely: ${cidr}`);
  }

  const reserved = new Set<string>();
  for (const ip of reservedIps) {
    ipToNum(ip);
    reserved.add(ip);
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
  const { base, prefixLen } = parseCidr(cidr);
  const { networkAddr, broadcastAddr, usableHosts } = cidrBounds(base, prefixLen);
  if (usableHosts > MAX_MATERIALIZED_CIDR_HOSTS) {
    throw new Error(`CIDR is too large for bounded allocation: ${cidr}`);
  }
  const reserved = new Set(reservedIps.map((ip) => {
    ipToNum(ip);
    return ip;
  }));
  for (let numeric = networkAddr + 1; numeric < broadcastAddr; numeric += 1) {
    const ip = numToIp(numeric);
    if (reserved.has(ip)) continue;
    if (!usedIps.has(ip)) return ip;
  }
  return null;
}

/** True only for a non-network, non-broadcast IPv4 host inside the CIDR. */
export function isUsableHostInCidr(cidr: string, ip: string): boolean {
  try {
    const { base, prefixLen } = parseCidr(cidr);
    const { networkAddr, broadcastAddr } = cidrBounds(base, prefixLen);
    const numeric = ipToNum(ip);
    return numeric > networkAddr && numeric < broadcastAddr;
  } catch {
    return false;
  }
}

function cidrBounds(base: string, prefixLen: number): {
  networkAddr: number;
  broadcastAddr: number;
  usableHosts: number;
} {
  const baseNum = ipToNum(base);
  const hostBits = 32 - prefixLen;
  const size = 2 ** hostBits;
  const networkAddr = Math.floor(baseNum / size) * size;
  const broadcastAddr = networkAddr + size - 1;
  return {
    networkAddr,
    broadcastAddr,
    usableHosts: hostBits <= 1 ? 0 : size - 2,
  };
}

/** Sleep for ms milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Deterministic JSON used for task identities across Backend and Agent. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

/** Normalize a requested XFS quota to the 1 KiB block size used on the wire. */
export function normalizeXfsQuotaBytes(bytes: number): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error(`Invalid quota byte limit: ${bytes}`);
  }
  return Math.ceil(bytes / 1024) * 1024;
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
