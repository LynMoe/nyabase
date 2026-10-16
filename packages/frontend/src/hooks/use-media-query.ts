import { useSyncExternalStore } from 'react';

/** Live `window.matchMedia` result; false where matchMedia is unavailable (tests). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}

/** Below Tailwind's `md` breakpoint, where wide tables become card lists. */
export function useIsNarrow(): boolean {
  return useMediaQuery('(max-width: 767px)');
}
