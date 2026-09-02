export const NVIDIA_GPU_RUNTIME_UNAVAILABLE = 'NVIDIA_GPU_RUNTIME_UNAVAILABLE';
export const NVIDIA_GPU_INVALID_PCI = 'NVIDIA_GPU_INVALID_PCI';
export const NVIDIA_GPU_WILDCARD_FORBIDDEN = 'NVIDIA_GPU_WILDCARD_FORBIDDEN';
export const NVIDIA_GPU_DUPLICATE_PCI = 'NVIDIA_GPU_DUPLICATE_PCI';

const NVIDIA_GPU_ERROR_ZH: Readonly<Record<string, string>> = {
  [NVIDIA_GPU_RUNTIME_UNAVAILABLE]: 'GPU 运行时不可用',
  [NVIDIA_GPU_INVALID_PCI]: 'PCI 地址无效',
  [NVIDIA_GPU_WILDCARD_FORBIDDEN]: '禁止使用通配符 PCI 选择器',
  [NVIDIA_GPU_DUPLICATE_PCI]: 'PCI 地址重复',
};

export function nvidiaGpuFormatError(code: string): string | undefined {
  return NVIDIA_GPU_ERROR_ZH[code];
}

/** Matches the host PackageHttpError shape without importing Nest. */
export class PackageHttpError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'PackageHttpError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
