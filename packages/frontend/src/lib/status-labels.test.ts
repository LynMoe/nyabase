import { describe, expect, it } from 'vitest';
import { FailureCode } from '@nyabase/common';
import { failureCodeLabel } from './status-labels.js';

describe('failureCodeLabel GPU codes', () => {
  it('renders GPU failure codes in Chinese', () => {
    expect(failureCodeLabel(FailureCode.GpuWildcardForbidden)).toBe('禁止使用通配符 PCI 选择器');
    expect(failureCodeLabel(FailureCode.GpuInvalidPci)).toBe('PCI 地址无效');
    expect(failureCodeLabel(FailureCode.GpuDuplicatePci)).toBe('PCI 地址重复');
    expect(failureCodeLabel(FailureCode.GpuRuntimeUnavailable)).toBe('GPU 运行时不可用');
    expect(failureCodeLabel(FailureCode.GpuNotEnabled)).toBe('服务器未启用 GPU');
  });

  it('keeps unknown codes verbatim', () => {
    expect(failureCodeLabel('NO_SUCH_CODE')).toBe('NO_SUCH_CODE');
    expect(failureCodeLabel(null)).toBeNull();
  });
});
