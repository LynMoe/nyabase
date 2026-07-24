import { api } from './api.js';
import { clearLocalSession, type CapturedSession } from './auth-session.js';

export async function runSessionTermination(
  clear: () => CapturedSession,
  revoke: (session: CapturedSession) => Promise<void>,
): Promise<void> {
  const captured = clear();
  try {
    await revoke(captured);
  } catch {
    // Local fail-closed termination is authoritative; revocation is best effort.
  }
}

/** Capture the old family, fail closed locally, then revoke only that family. */
export function terminateBrowserSession(): Promise<void> {
  return runSessionTermination(() => clearLocalSession(), api.logout);
}
