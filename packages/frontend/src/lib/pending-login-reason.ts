export type PendingLoginReason = 'password-changed' | 'account-changed' | 'session-expired';

const STORAGE_KEY = 'nyabase.pendingLoginReason';

function isPendingLoginReason(value: string | null): value is PendingLoginReason {
  return value === 'password-changed'
    || value === 'account-changed'
    || value === 'session-expired';
}

export function setPendingLoginReason(reason: PendingLoginReason): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, reason);
  } catch {
    // sessionStorage may be unavailable; login banner is best-effort.
  }
}

export function peekPendingLoginReason(): PendingLoginReason | undefined {
  try {
    const value = sessionStorage.getItem(STORAGE_KEY);
    return isPendingLoginReason(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function clearPendingLoginReason(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/** Read and clear the pending login reason in one step. */
export function takePendingLoginReason(): PendingLoginReason | undefined {
  const reason = peekPendingLoginReason();
  clearPendingLoginReason();
  return reason;
}
