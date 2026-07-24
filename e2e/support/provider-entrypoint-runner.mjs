import { spawn } from 'node:child_process';
import { sanitizeDiagnosticText } from './error-diagnostics.mjs';

const maxDiagnosticBytes = 8 * 1024;
const maxDiagnosticChars = 3_000;

const profiles = Object.freeze({
  containerSsh: Object.freeze({
    deadlineMs: 240_000,
    maxOutputBytes: 64 * 1024,
    deadlineMessage: 'Container SSH provider operation exceeded its 240000ms deadline',
    outputLimitMessage: 'Container SSH provider operation exceeded its output limit',
    diagnosticLimitMessage: 'Container SSH provider operation exceeded its diagnostic output limit',
    startMessage: 'Container SSH provider operation could not start',
    failureMessage: () => 'Container SSH provider operation failed',
  }),
  topologyFault: Object.freeze({
    deadlineMs: 210_000,
    maxOutputBytes: 2 * 1024 * 1024,
    deadlineMessage: 'Topology provider fault operation exceeded its 210000ms deadline',
    outputLimitMessage: 'Topology provider fault operation exceeded its output limit',
    diagnosticLimitMessage:
      'Topology provider fault operation exceeded its diagnostic output limit',
    startMessage: 'Topology provider fault operation could not start',
    failureMessage: (status) => `Topology provider fault operation failed (${status})`,
  }),
  recoveryFault: Object.freeze({
    deadlineMs: 150_000,
    maxOutputBytes: 256 * 1024,
    deadlineMessage: 'Recovery proof fault exceeded its 150000ms deadline',
    outputLimitMessage: 'Recovery proof fault exceeded its output limit',
    diagnosticLimitMessage: 'Recovery proof fault exceeded its diagnostic output limit',
    startMessage: 'Recovery proof fault could not start',
    failureMessage: (status) => `Recovery proof fault failed (${status})`,
  }),
});

function runProviderEntrypoint(entrypoint, runtimeRoot, input, profile) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, runtimeRoot], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let diagnosticBytes = 0;
    let settled = false;
    let timer;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(message));
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(profile.deadlineMessage);
    }, profile.deadlineMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > profile.maxOutputBytes) {
        child.kill('SIGKILL');
        fail(profile.outputLimitMessage);
        return;
      }
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes > maxDiagnosticBytes) {
        child.kill('SIGKILL');
        fail(profile.diagnosticLimitMessage);
        return;
      }
      stderr += chunk.toString('utf8');
    });
    child.once('error', () => fail(profile.startMessage));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0) {
        const status = String(code ?? signal);
        fail(
          `${profile.failureMessage(status)}: ${sanitizeDiagnosticText(stderr, maxDiagnosticChars)}`,
        );
        return;
      }
      settled = true;
      resolvePromise(stdout.trim());
    });
    child.stdin.end(`${JSON.stringify(input)}\n`);
  });
}

export function runContainerSshProviderEntrypoint(entrypoint, runtimeRoot, input) {
  return runProviderEntrypoint(entrypoint, runtimeRoot, input, profiles.containerSsh);
}

export function runTopologyFaultProviderEntrypoint(entrypoint, runtimeRoot, input) {
  return runProviderEntrypoint(entrypoint, runtimeRoot, input, profiles.topologyFault);
}

export function runRecoveryFaultProviderEntrypoint(entrypoint, runtimeRoot, input) {
  return runProviderEntrypoint(entrypoint, runtimeRoot, input, profiles.recoveryFault);
}
