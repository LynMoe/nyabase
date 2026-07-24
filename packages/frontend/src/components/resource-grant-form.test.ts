import { describe, expect, it } from 'vitest';
import { GpuGrantMode } from '@nyabase/common';
import { formToGrantPayload, grantToForm, type ResourceFormValue } from './resource-grant-form.js';

const base: ResourceFormValue = {
  cpuCores: '',
  memGb: '',
  diskGb: '',
  gpuMode: '',
  gpuIndices: '',
};

describe('formToGrantPayload', () => {
  it('writes an explicit no-GPU grant for a known CPU-only server', () => {
    expect(formToGrantPayload(base, { availableGpuIndices: [] })).toMatchObject({
      gpuMode: GpuGrantMode.None,
      gpuIndices: [],
    });
  });

  it.each([
    { ...base, cpuCores: '1e309' },
    { ...base, memGb: '1e30' },
    { ...base, diskGb: '0.00000000001' },
  ])('rejects non-finite, unsafe, and silently-zero limits', (form) => {
    expect(() => formToGrantPayload(form)).toThrow();
  });

  it('requires unique, existing indices in indices mode', () => {
    expect(() => formToGrantPayload(
      { ...base, gpuMode: GpuGrantMode.Indices, gpuIndices: '0,0' },
      { availableGpuIndices: [0, 1] },
    )).toThrow('不能重复');
    expect(() => formToGrantPayload(
      { ...base, gpuMode: GpuGrantMode.Indices, gpuIndices: '2' },
      { availableGpuIndices: [0, 1] },
    )).toThrow('不在当前服务器清单');
    expect(() => formToGrantPayload(
      { ...base, gpuMode: GpuGrantMode.Indices, gpuIndices: '' },
      { availableGpuIndices: [0, 1] },
    )).toThrow('非空');
  });

  it('normalizes a valid resource grant without changing zero semantics', () => {
    expect(formToGrantPayload(
      { ...base, cpuCores: '2.5', memGb: '4', diskGb: '0', gpuMode: GpuGrantMode.Indices, gpuIndices: '1,0' },
      { availableGpuIndices: [0, 1] },
    )).toEqual({
      cpuMillis: 2500,
      memBytes: 4 * 1024 ** 3,
      diskBytes: 0,
      gpuMode: GpuGrantMode.Indices,
      gpuIndices: [0, 1],
    });
  });

  it('round-trips non-round stored limits without silently changing them', () => {
    const stored = {
      cpuMillis: 1,
      memBytes: 1,
      diskBytes: 1_234_567_891,
      gpuMode: GpuGrantMode.None,
      gpuIndices: [] as number[],
    };
    expect(formToGrantPayload(grantToForm(stored))).toEqual(stored);
  });
});
