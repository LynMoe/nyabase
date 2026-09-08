import { describe, expect, it } from 'vitest';
import { GROUP_DETAIL_TABS, parseGroupDetailTab } from './group-detail.js';
import { USER_DETAIL_TABS, parseUserDetailTab } from './user-detail.js';

describe('IAM detail tabs', () => {
  it('defaults user tabs to overview', () => {
    expect(parseUserDetailTab(undefined)).toBe('overview');
    expect(parseUserDetailTab('grants')).toBe('grants');
    expect(parseUserDetailTab('members')).toBe('overview');
    expect(USER_DETAIL_TABS).toEqual(['overview', 'grants']);
  });

  it('defaults group tabs to overview', () => {
    expect(parseGroupDetailTab(undefined)).toBe('overview');
    expect(parseGroupDetailTab('members')).toBe('members');
    expect(parseGroupDetailTab('grants')).toBe('grants');
    expect(parseGroupDetailTab('assignments')).toBe('overview');
    expect(GROUP_DETAIL_TABS).toEqual(['overview', 'members', 'grants']);
  });
});
