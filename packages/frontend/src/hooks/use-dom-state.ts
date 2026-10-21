import * as React from 'react';
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

export type ScrollOverflow = { start: boolean; end: boolean };

function measure(el: HTMLElement, axis: 'x' | 'y'): ScrollOverflow {
  if (axis === 'x') {
    return {
      start: el.scrollLeft > 1,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    };
  }
  return {
    start: el.scrollTop > 1,
    end: el.scrollTop + el.clientHeight < el.scrollHeight - 1,
  };
}

/** Track whether a scrollport can still move toward the start or end. */
export function useScrollOverflow(axis: 'x' | 'y'): [React.RefObject<HTMLDivElement | null>, ScrollOverflow] {
  const ref = React.useRef<HTMLDivElement>(null);
  const [state, setState] = React.useState<ScrollOverflow>({ start: false, end: false });

  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const update = () => setState(measure(el, axis));
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, [axis]);

  return [ref, state];
}

/** Grows each time a dialog opens; as the body `key` it resets form state but keeps the exit animation. */
export function useOpenSession(open: boolean): number {
  const [session, setSession] = React.useState(0);
  const [wasOpen, setWasOpen] = React.useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setSession((current) => current + 1);
  }
  return session;
}
