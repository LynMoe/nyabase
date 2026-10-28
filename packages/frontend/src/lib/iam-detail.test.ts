import { describe, expect, it } from 'vitest';
import { USER_DETAIL_TABS, parseUserDetailTab } from './detail-tabs.js';

describe('IAM detail tabs', () => {
  it('defaults user tabs to overview', () => {
    expect(parseUserDetailTab(undefined)).toBe('overview');
    expect(parseUserDetailTab('grants')).toBe('grants');
    expect(parseUserDetailTab('members')).toBe('overview');
    expect(USER_DETAIL_TABS).toEqual(['overview', 'grants']);
  });

});
