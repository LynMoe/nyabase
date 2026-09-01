import * as React from 'react';

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
