import { describe, expect, it } from 'vitest';
import {
  summarizeGpuSupport,
  type GpuSupportCheckDto,
} from './support.js';

function check(
  status: GpuSupportCheckDto['status'],
  id: string = status,
): GpuSupportCheckDto {
  return { id, label: id, status };
}

describe('summarizeGpuSupport', () => {
  it('treats an empty checklist as supported', () => {
    expect(summarizeGpuSupport([])).toEqual({ supported: true, checks: [] });
  });

  it('is true only when every check passed', () => {
    const checks = [check('pass', 'a'), check('pass', 'b')];
    expect(summarizeGpuSupport(checks)).toEqual({ supported: true, checks });
  });

  it('fails when any check failed, even if others are unknown', () => {
    const checks = [check('pass'), check('unknown'), check('fail')];
    expect(summarizeGpuSupport(checks).supported).toBe(false);
  });

  it('is unknown when nothing failed but at least one check is unknown', () => {
    const checks = [check('pass'), check('unknown')];
    expect(summarizeGpuSupport(checks).supported).toBeNull();
  });
});
