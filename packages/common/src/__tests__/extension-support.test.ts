import { describe, expect, it } from 'vitest';
import {
  summarizeExtensionSupport,
  type ExtensionSupportCheckDto,
} from '../protocol/server-card-extensions.js';

function check(
  status: ExtensionSupportCheckDto['status'],
  id: string = status,
): ExtensionSupportCheckDto {
  return { id, label: id, status };
}

describe('summarizeExtensionSupport', () => {
  it('treats an empty checklist as supported', () => {
    expect(summarizeExtensionSupport([])).toEqual({ supported: true, checks: [] });
  });

  it('is true only when every check passed', () => {
    const checks = [check('pass', 'a'), check('pass', 'b')];
    expect(summarizeExtensionSupport(checks)).toEqual({ supported: true, checks });
  });

  it('fails when any check failed, even if others are unknown', () => {
    const checks = [check('pass'), check('unknown'), check('fail')];
    expect(summarizeExtensionSupport(checks).supported).toBe(false);
  });

  it('is unknown when nothing failed but at least one check is unknown', () => {
    const checks = [check('pass'), check('unknown')];
    expect(summarizeExtensionSupport(checks).supported).toBeNull();
  });
});
