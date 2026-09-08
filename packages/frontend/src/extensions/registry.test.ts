import { describe, expect, it } from 'vitest';
import { failureCodeLabel } from '../lib/status-labels.js';
import {
  formatExtensionGrantSummaries,
  formatRegisteredExtensionError,
  registerExtensionErrorFormatters,
  registerServerCardExtensions,
} from './registry.js';

describe('merged extension error formatters', () => {
  it('renders package codes after core labels', () => {
    registerExtensionErrorFormatters([
      (code) => (code === 'PKG_WILDCARD_FORBIDDEN' ? '禁止使用通配符 PCI 选择器' : undefined),
    ]);
    expect(formatRegisteredExtensionError('PKG_WILDCARD_FORBIDDEN')).toBe('禁止使用通配符 PCI 选择器');
    expect(failureCodeLabel('PKG_WILDCARD_FORBIDDEN')).toBe('禁止使用通配符 PCI 选择器');
    expect(failureCodeLabel('EXTENSION_NOT_ENABLED')).toBe('服务器扩展未启用');
  });
});

describe('formatExtensionGrantSummaries', () => {
  it('collects non-empty chips and ignores null formatters', () => {
    registerServerCardExtensions([
      {
        id: 'alpha',
        slots: {},
        formatError: () => undefined,
        formatGrantSummary: (grants) => (grants.flag ? 'CHIP' : null),
      },
      {
        id: 'beta',
        slots: {},
        formatError: () => undefined,
      },
    ]);
    expect(formatExtensionGrantSummaries({ flag: true })).toEqual(['CHIP']);
    expect(formatExtensionGrantSummaries({})).toEqual([]);
    expect(formatExtensionGrantSummaries(undefined)).toEqual([]);
    registerServerCardExtensions([]);
  });
});
