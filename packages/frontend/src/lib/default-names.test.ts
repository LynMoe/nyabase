import { describe, expect, it } from 'vitest';
import { zCreateContainerRequest, zCreateVolumeRequest } from '@nyabase/common';
import { CONTAINER_NAME_MAX_LENGTH, CONTAINER_NAME_RE } from '@nyabase/common';
import { dateStamp, defaultContainerName, defaultResourceName } from './default-names.js';

const OCT_25 = new Date(2026, 9, 25, 23, 59);

describe('dateStamp', () => {
  it('formats the local date as yymmdd', () => {
    expect(dateStamp(OCT_25)).toBe('261025');
    expect(dateStamp(new Date(2030, 0, 5, 0, 0))).toBe('300105');
  });
});

describe('defaultResourceName', () => {
  it('uses the bare date name when it is free', () => {
    expect(defaultResourceName('ins', [], OCT_25)).toBe('ins-261025');
    expect(defaultResourceName('vol', ['ins-261025'], OCT_25)).toBe('vol-261025');
  });

  it('appends -2, -3, … past taken names', () => {
    expect(defaultResourceName('ins', ['ins-261025'], OCT_25)).toBe('ins-261025-2');
    expect(defaultResourceName('ins', ['ins-261025', 'ins-261025-2', 'ins-261025-4'], OCT_25)).toBe('ins-261025-3');
  });

  it('compares names case-insensitively and ignores surrounding spaces', () => {
    expect(defaultResourceName('vol', [' VOL-261025 ', 'Vol-261025-2'], OCT_25)).toBe('vol-261025-3');
  });

  it('passes the container and volume name validation', () => {
    const container = defaultResourceName('ins', ['ins-261025'], OCT_25);
    expect(zCreateContainerRequest.shape.name.safeParse(container).success).toBe(true);
    const volume = defaultResourceName('vol', [], OCT_25);
    expect(zCreateVolumeRequest.shape.name.safeParse(volume).success).toBe(true);
  });
});

describe('defaultContainerName', () => {
  it('joins the username and the server', () => {
    expect(defaultContainerName('admin', 'a800-4', [])).toBe('admin-a800-4');
    expect(defaultContainerName('weihaichuan', 'h100-1', [])).toBe('weihaichuan-h100-1');
  });

  it('skips names the user already has, ignoring case', () => {
    expect(defaultContainerName('admin', 'a800-4', ['Admin-A800-4', 'admin-a800-4-2'])).toBe('admin-a800-4-3');
  });

  it('reduces any server or user name to a valid container name', () => {
    expect(defaultContainerName('a_b', 'GPU 机器 #1', [])).toBe('a-b-gpu-1');
    expect(defaultContainerName('--bob', '东区', [])).toBe('bob');
    expect(defaultContainerName('admin', '', [])).toBe('admin');
    expect(defaultContainerName('__', '东区', [], OCT_25)).toBe('ins-261025');
  });

  it('stays within the limit, the username giving way first, also with a suffix', () => {
    const owner = 'u'.repeat(64);
    const first = defaultContainerName(owner, 'a800-4', []);
    expect(first).toBe(`${'u'.repeat(CONTAINER_NAME_MAX_LENGTH - 7)}-a800-4`);
    const second = defaultContainerName(owner, 'a800-4', [first]);
    expect(second.length).toBeLessThanOrEqual(CONTAINER_NAME_MAX_LENGTH);
    expect(second.endsWith('-a800-4-2')).toBe(true);
    const long = defaultContainerName('admin', 'x'.repeat(100), []);
    expect(long.length).toBeLessThanOrEqual(CONTAINER_NAME_MAX_LENGTH);
    expect(long).toMatch(CONTAINER_NAME_RE);
  });
});
