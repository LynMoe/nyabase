import { describe, expect, it } from 'vitest';
import { failureCodeLabel } from '../lib/status-labels.js';
import {
  formatRegisteredExtensionError,
  registerExtensionErrorFormatters,
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
