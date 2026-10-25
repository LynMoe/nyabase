import { useState } from 'react';

/**
 * Page-by-page navigation over a cursor-paginated API (no total count): a
 * stack of the cursors that opened each page after the first. `cursors[i]`
 * opens page `i + 1`, so going back needs no extra request.
 *
 * The stack belongs to one `resetKey` (the filters and page size): when the
 * key changes the view is back on page 1, without an effect or a second render.
 */
export interface CursorPageState {
  key: string;
  cursors: readonly string[];
}

export function cursorsFor(state: CursorPageState, resetKey: string): readonly string[] {
  return state.key === resetKey ? state.cursors : [];
}

export function nextCursorPage(
  state: CursorPageState,
  resetKey: string,
  nextCursor: string | null | undefined,
): CursorPageState {
  const cursors = cursorsFor(state, resetKey);
  return { key: resetKey, cursors: nextCursor ? [...cursors, nextCursor] : cursors };
}

export function previousCursorPage(state: CursorPageState, resetKey: string): CursorPageState {
  return { key: resetKey, cursors: cursorsFor(state, resetKey).slice(0, -1) };
}

export function useCursorPages(resetKey: string) {
  const [state, setState] = useState<CursorPageState>({ key: resetKey, cursors: [] });
  const cursors = cursorsFor(state, resetKey);
  return {
    /** Zero-based page index. */
    page: cursors.length,
    /** Cursor for the current page; undefined on page 1. */
    cursor: cursors.at(-1),
    next: (nextCursor: string | null | undefined) =>
      setState((current) => nextCursorPage(current, resetKey, nextCursor)),
    previous: () => setState((current) => previousCursorPage(current, resetKey)),
  };
}
