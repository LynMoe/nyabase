#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  containsForbiddenCredentialPattern,
  knownSecretsFromEnv,
  redactArtifactText,
} from './playwright-artifact-security.mjs';
import { loadValidatedRunState } from './run-state-contract.mjs';

export const MAX_DIAGNOSTIC_FILE_BYTES = 4 * 1024 * 1024;
const HEAD_BYTES = 2 * 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const TRUNCATION_MARKER = '\n…[bounded diagnostic middle omitted]…\n';

function utf8Prefix(value, maxBytes) {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(0, low);
}

function utf8Suffix(value, maxBytes) {
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(value.length - middle)) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return value.slice(value.length - low);
}

function boundRedactedText(value) {
  if (Buffer.byteLength(value) <= MAX_DIAGNOSTIC_FILE_BYTES) return value;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  const available = MAX_DIAGNOSTIC_FILE_BYTES - markerBytes;
  return utf8Prefix(value, Math.floor(available / 2))
    + TRUNCATION_MARKER
    + utf8Suffix(value, Math.ceil(available / 2));
}

function completeHeadLines(value) {
  const boundary = value.lastIndexOf(0x0a);
  return boundary < 0 ? Buffer.alloc(0) : value.subarray(0, boundary + 1);
}

function completeTailLines(value) {
  const boundary = value.indexOf(0x0a);
  return boundary < 0 ? Buffer.alloc(0) : value.subarray(boundary + 1);
}

/** Drain an arbitrary producer while retaining a bounded first-fault and final-state window. */
export async function captureDiagnosticInput(input, secrets = []) {
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  let totalBytes = 0;

  for await (const value of input) {
    let chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    totalBytes += chunk.length;
    if (headBytes < HEAD_BYTES) {
      const take = Math.min(HEAD_BYTES - headBytes, chunk.length);
      head.push(Buffer.from(chunk.subarray(0, take)));
      headBytes += take;
      chunk = chunk.subarray(take);
    }
    if (chunk.length === 0) continue;
    tail.push(Buffer.from(chunk));
    tailBytes += chunk.length;
    while (tailBytes > TAIL_BYTES && tail.length > 0) {
      const excess = tailBytes - TAIL_BYTES;
      if (tail[0].length <= excess) {
        tailBytes -= tail.shift().length;
      } else {
        tail[0] = Buffer.from(tail[0].subarray(excess));
        tailBytes -= excess;
      }
    }
  }

  const omitted = Math.max(0, totalBytes - headBytes - tailBytes);
  const headBuffer = Buffer.concat(head);
  const tailBuffer = Buffer.concat(tail);
  const raw = Buffer.concat([
    omitted > 0 ? completeHeadLines(headBuffer) : headBuffer,
    ...(omitted > 0 ? [Buffer.from(TRUNCATION_MARKER)] : []),
    omitted > 0 ? completeTailLines(tailBuffer) : tailBuffer,
  ]).toString('utf8');
  let redacted = redactArtifactText(raw, secrets);
  if (containsForbiddenCredentialPattern(redacted)) {
    redacted = '[diagnostic withheld: credential redaction could not be verified]\n';
  }
  redacted = boundRedactedText(redacted);
  if (containsForbiddenCredentialPattern(redacted)) {
    return Buffer.from('[diagnostic withheld: bounded output failed credential audit]\n');
  }
  return Buffer.from(redacted);
}

async function main() {
  const runtimeDir = resolve(process.argv[2] ?? '');
  const filename = process.argv[3] ?? '';
  if (!process.argv[2] || !/^[a-z0-9][a-z0-9.-]{0,63}$/u.test(filename)) {
    throw new Error('usage: capture-diagnostic.mjs <runtimeDir> <safe-filename>');
  }
  await loadValidatedRunState(runtimeDir);
  const diagnostics = join(runtimeDir, 'diagnostics');
  await mkdir(diagnostics, { recursive: true, mode: 0o700 });
  await chmod(diagnostics, 0o700);
  const info = await lstat(diagnostics);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('diagnostics path must be a real directory');
  }
  const secrets = knownSecretsFromEnv(await readFile(join(runtimeDir, 'secrets.env'), 'utf8'));
  const bytes = await captureDiagnosticInput(process.stdin, secrets);
  const destination = join(diagnostics, filename);
  if (basename(destination) !== filename) throw new Error('diagnostic filename escapes its directory');
  const temporary = join(diagnostics, `.${filename}.${process.pid}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  await chmod(destination, 0o600);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
