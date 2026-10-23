const RELOAD_AT_KEY = 'nyabase:stale-bundle-reload-at';
/** A second chunk failure this soon after our own reload is not a stale tab. */
export const STALE_BUNDLE_RELOAD_GUARD_MS = 30_000;

interface ReloadHost {
  addEventListener(type: 'vite:preloadError', listener: () => void): void;
  readonly sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
  readonly location: { reload(): void };
  readonly navigator: { readonly onLine: boolean };
}

/**
 * After a redeploy the hashed chunks an open tab knows about are gone, so the
 * next lazy route import fails (Vite reports it as `vite:preloadError`).
 * Reload once to pick up the new index.html. A timestamp in sessionStorage
 * stops a reload loop when the failure is real (broken deploy); then, or when
 * storage is unavailable, the error reaches the error boundary. A browser that
 * knows it is offline is not reloaded at all: that would only replace the app
 * with the browser's offline page, and the guard would then be spent.
 */
export function reloadOnStaleBundle(host: ReloadHost, now: () => number = Date.now): void {
  host.addEventListener('vite:preloadError', () => {
    if (host.navigator.onLine === false) return;
    try {
      const storage = host.sessionStorage;
      const last = Number(storage.getItem(RELOAD_AT_KEY));
      if (Number.isFinite(last) && last > 0 && now() - last < STALE_BUNDLE_RELOAD_GUARD_MS) return;
      storage.setItem(RELOAD_AT_KEY, String(now()));
    } catch {
      return;
    }
    host.location.reload();
  });
}
