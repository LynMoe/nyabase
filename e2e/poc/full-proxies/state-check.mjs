import { readFileSync } from 'node:fs';

const mode = process.argv[2];
const state = JSON.parse(readFileSync(0, 'utf8'));
let ok = false;
if (mode === 'initial') {
  ok = state.revoked === false
    && state.ssh?.connected === true
    && state.http?.connected === true
    && state.ssh?.ackGeneration >= 1
    && state.http?.ackGeneration >= 1;
} else if (mode === 'active') {
  ok = state.ssh?.activeConnections >= 1 && state.http?.activeConnections >= 1;
} else if (mode === 'revoked') {
  ok = state.revoked === true
    && state.ssh?.ackGeneration >= 2
    && state.http?.ackGeneration >= 2;
} else if (mode === 'quiescent') {
  ok = state.revoked === true
    && state.ssh?.ackGeneration >= 2
    && state.http?.ackGeneration >= 2
    && state.ssh?.activeConnections === 0
    && state.http?.activeConnections === 0;
}
if (!ok) process.exit(1);
