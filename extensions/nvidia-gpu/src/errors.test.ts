import { describe, expect, it } from 'vitest';
import {
  NVIDIA_GPU_DUPLICATE_PCI,
  NVIDIA_GPU_INVALID_PCI,
  NVIDIA_GPU_RUNTIME_UNAVAILABLE,
  NVIDIA_GPU_WILDCARD_FORBIDDEN,
  nvidiaGpuFormatError,
} from './errors.js';

describe('nvidiaGpuFormatError', () => {
  it('renders NVIDIA package codes in Chinese', () => {
    expect(nvidiaGpuFormatError(NVIDIA_GPU_WILDCARD_FORBIDDEN)).toBe('禁止使用通配符 PCI 选择器');
    expect(nvidiaGpuFormatError(NVIDIA_GPU_INVALID_PCI)).toBe('PCI 地址无效');
    expect(nvidiaGpuFormatError(NVIDIA_GPU_DUPLICATE_PCI)).toBe('PCI 地址重复');
    expect(nvidiaGpuFormatError(NVIDIA_GPU_RUNTIME_UNAVAILABLE)).toBe('GPU 运行时不可用');
  });

  it('returns undefined for unknown codes', () => {
    expect(nvidiaGpuFormatError('EXTENSION_UNKNOWN')).toBeUndefined();
  });
});
