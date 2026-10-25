import { describe, expect, it } from 'vitest';
import { cursorsFor, nextCursorPage, previousCursorPage, type CursorPageState } from './use-cursor-pages.js';

describe('cursor pages', () => {
  const start: CursorPageState = { key: 'a', cursors: [] };

  it('pushes the next cursor and pops it to go back', () => {
    const page2 = nextCursorPage(start, 'a', 'c1');
    const page3 = nextCursorPage(page2, 'a', 'c2');
    expect(cursorsFor(page3, 'a')).toEqual(['c1', 'c2']);
    expect(cursorsFor(previousCursorPage(page3, 'a'), 'a')).toEqual(['c1']);
    expect(cursorsFor(previousCursorPage(start, 'a'), 'a')).toEqual([]);
  });

  it('stays on the page when there is no next cursor', () => {
    expect(cursorsFor(nextCursorPage(start, 'a', null), 'a')).toEqual([]);
  });

  it('is back on page 1 when the reset key (filters, page size) changes', () => {
    const page3 = nextCursorPage(nextCursorPage(start, 'a', 'c1'), 'a', 'c2');
    expect(cursorsFor(page3, 'b')).toEqual([]);
    expect(cursorsFor(nextCursorPage(page3, 'b', 'd1'), 'b')).toEqual(['d1']);
  });
});
