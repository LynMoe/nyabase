#!/usr/bin/env node
import { sanitizeDiagnosticText } from '../support/error-diagnostics.mjs';

const chunks = [];
let bytes = 0;
for await (const chunk of process.stdin) {
  bytes += chunk.length;
  if (bytes > 65_536) throw new Error('cleanup diagnostic input exceeds 65536 bytes');
  chunks.push(chunk);
}
process.stdout.write(`${sanitizeDiagnosticText(Buffer.concat(chunks), 65_536)}\n`);
