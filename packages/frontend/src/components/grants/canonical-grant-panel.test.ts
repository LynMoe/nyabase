import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GRANT_EXPIRY_GRACE_DAYS } from '@nyabase/common';
import { expiryPhase, toDatetimeLocalValue } from './use-grant-panel-data.js';

describe('toDatetimeLocalValue', () => {
  it('formats local calendar time without seconds or timezone', () => {
    const date = new Date(2026, 0, 15, 9, 5, 30);
    expect(toDatetimeLocalValue(date)).toBe('2026-01-15T09:05');
  });
});

describe('expiryPhase', () => {
  const dayMs = 24 * 60 * 60 * 1000;
  const ago = (days: number) => new Date(Date.now() - days * dayMs).toISOString();

  it('judges one grant by its own expiry: live, within the 14-day grace, or past it', () => {
    expect(expiryPhase(null)).toBe('live');
    expect(expiryPhase(new Date(Date.now() + dayMs).toISOString())).toBe('live');
    expect(expiryPhase(ago(1))).toBe('grace');
    expect(expiryPhase(ago(GRANT_EXPIRY_GRACE_DAYS - 1))).toBe('grace');
    expect(expiryPhase(ago(GRANT_EXPIRY_GRACE_DAYS + 1))).toBe('lost');
  });
});

describe('grant panel copy', () => {
  const source = ['./canonical-grant-panel.tsx', './grant-cards.tsx']
    .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .join('\n');

  it('warns that revoking starts the grace and ends with a purge of the resources', () => {
    expect(source).toContain('${GRANT_EXPIRY_GRACE_DAYS} 天后清除');
  });
});
