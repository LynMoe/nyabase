#!/usr/bin/env node

const [candidate, ...existing] = process.argv.slice(2);
if (!candidate) throw new Error('candidate CIDR is required');

function range(cidr) {
  const match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((value) => value < 0 || value > 255) || prefix < 0 || prefix > 32) return null;
  const address = octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
  const hostBits = 32n - BigInt(prefix);
  const size = 1n << hostBits;
  const start = (address / size) * size;
  return { start, end: start + size - 1n };
}

const wanted = range(candidate);
if (!wanted) throw new Error(`invalid candidate CIDR: ${candidate}`);
const overlaps = existing.some((cidr) => {
  const current = range(cidr);
  return current && wanted.start <= current.end && current.start <= wanted.end;
});
process.exit(overlaps ? 0 : 1);
