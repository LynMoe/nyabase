import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

describe('DialogContent body', () => {
  it('scrolls by flex, because a percentage height does not resolve under an auto-height dialog', () => {
    const source = readFileSync(new URL('./dialog.tsx', import.meta.url), 'utf8');
    expect(source).toContain('relative flex min-h-0 flex-1 flex-col overflow-hidden');
    expect(source).toContain('min-h-0 flex-1 space-y-4 overflow-y-auto');
  });
});
