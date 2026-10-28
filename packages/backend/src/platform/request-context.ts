import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * An administrator acting as `userId` for the duration of one HTTP request
 * (`X-Nyabase-Act-As`). The audit writer reads it to record who really did
 * what. `active` is cleared when the request settles: timers and promise
 * chains started inside the request inherit this object, and must not stamp
 * rows they write later.
 */
export interface ImpersonationContext {
  readonly userId: string;
  readonly impersonatorId: string;
  active: boolean;
}

const storage = new AsyncLocalStorage<ImpersonationContext>();

/** Runs `work` (and everything it starts synchronously) as `context`. */
export function runImpersonated<T>(context: ImpersonationContext, work: () => T): T {
  return storage.run(context, work);
}

/** The impersonation of the request in flight, if any. */
export function currentImpersonation(): ImpersonationContext | null {
  const context = storage.getStore();
  return context?.active ? context : null;
}

/**
 * Runs `work` outside any request context. Long-lived loops woken by a
 * request (the reconcile worker) must not inherit it: they keep running work
 * for other requests long after this one ended.
 */
export function outsideRequestContext<T>(work: () => T): T {
  return storage.exit(work);
}
