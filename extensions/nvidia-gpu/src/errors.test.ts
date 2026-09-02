import { describe, expect, it } from 'vitest';
import {
  NVIDIA_GPU_DUPLICATE_PCI,
  NVIDIA_GPU_INVALID_PCI,
  NVIDIA_GPU_RUNTIME_UNAVAILABLE,
  NVIDIA_GPU_WILDCARD_FORBIDDEN,
  isPackageHttpError,
  nvidiaGpuFormatError,
  PackageHttpError,
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

describe('isPackageHttpError', () => {
  it('duck-types statusCode/code/details without requiring instanceof', () => {
    const thrown = new PackageHttpError(400, NVIDIA_GPU_INVALID_PCI, 'nope');
    expect(isPackageHttpError(thrown)).toBe(true);
    expect(isPackageHttpError({
      name: 'PackageHttpError',
      statusCode: 409,
      code: 'EXTENSION_OCCUPIED',
      details: {},
      message: 'occupied',
    })).toBe(true);
    expect(isPackageHttpError(new Error('nope'))).toBe(false);
  });
});
