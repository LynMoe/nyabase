import { describe, expect, it } from 'vitest';
import { FailureCode } from '@nyabase/common';
import { failureCodeLabel, intentLabel } from './status-labels.js';

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

describe('storage labels', () => {
  it('renders the data-disk and mount failure codes in Chinese', () => {
    expect(failureCodeLabel(FailureCode.StorageMountPathConflict)).toMatch(/挂载点/);
    expect(failureCodeLabel(FailureCode.StorageMountUnsupported)).toMatch(/不能作为数据盘/);
    expect(failureCodeLabel(FailureCode.VolumeStillGranted)).toBe('仍有授权覆盖该盘，请先撤销授权');
  });

  it('names the platform\'s storage intents by their request', () => {
    expect(intentLabel({ kind: 'container.update', requestSummary: { operation: 'mount_volumes' } })).toBe('挂载数据盘');
    expect(intentLabel({ kind: 'container.update', requestSummary: { operation: 'storage_maintenance' } })).toBe('数据盘维护');
    expect(intentLabel({ kind: 'volume.resize', requestSummary: { source: 'quota_balancer' } })).toBe('自动调整数据卷额度');
    expect(intentLabel({ kind: 'volume.resize', requestSummary: {} })).toBe('调整数据卷');
    expect(intentLabel({ kind: 'container.update', requestSummary: { operation: 'limits' } })).toBe('更新容器');
  });
});
