import { describe, expect, it } from 'vitest';
import { Capability } from '@nyabase/common';
import {
  buildServerEditPatch,
  canViewAdminServerMetrics,
  createServerEditDraft,
} from './server-detail-logic.js';

describe('server detail capability and edit boundaries', () => {
  it('only mounts admin metrics for the capability accepted by the metrics API', () => {
    expect(canViewAdminServerMetrics([Capability.ViewMetricsAll])).toBe(true);
    expect(canViewAdminServerMetrics([Capability.ManageServers])).toBe(false);
    expect(canViewAdminServerMetrics([])).toBe(false);
  });

  it('creates a fresh draft from the latest server snapshot on each dialog mount', () => {
    expect(createServerEditDraft({ name: 'new-name', slug: 'new-slug' })).toEqual({
      name: 'new-name',
      slug: 'new-slug',
    });
  });

  it('patches only fields the editor actually changed', () => {
    const original = { name: 'old-name', slug: 'old-slug' };
    expect(buildServerEditPatch(original, { name: ' chosen-name ', slug: 'old-slug' })).toEqual({
      name: 'chosen-name',
    });
    expect(buildServerEditPatch(original, { name: 'old-name', slug: 'old-slug' })).toEqual({});
  });
});
