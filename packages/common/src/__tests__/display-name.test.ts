import { describe, expect, it } from 'vitest';
import {
  CONTAINER_NAME_MAX_LENGTH,
  ContainerPowerIntent,
  displayWidth,
  SERVER_NAME_MAX_WIDTH,
  serverNameProblem,
  zCreateContainerRequest,
  zCreateServerRequest,
  zPatchServerRequest,
} from '../index.js';

describe('displayWidth', () => {
  it('counts wide characters as two columns and combining marks as none', () => {
    expect(displayWidth('aya-1')).toBe(5);
    expect(displayWidth('Aya 1号机')).toBe(9);
    expect(displayWidth('ｱ')).toBe(1);
    expect(displayWidth('Ａ')).toBe(2);
    expect(displayWidth('한글')).toBe(4);
    expect(displayWidth('🚀')).toBe(2);
    expect(displayWidth('e\u0301')).toBe(1);
  });
});

describe('server names', () => {
  it('accept visible characters up to the column limit', () => {
    expect(serverNameProblem('Aya 1号机')).toBeNull();
    expect(serverNameProblem('a'.repeat(SERVER_NAME_MAX_WIDTH))).toBeNull();
    expect(serverNameProblem('机'.repeat(SERVER_NAME_MAX_WIDTH / 2))).toBeNull();
  });

  it('refuse control and invisible formatting characters', () => {
    for (const name of ['a\tb', 'a\nb', 'a\u001b[31m', 'a\u200bb', 'a\u202eb', 'a\u00a0b', 'a\u2028b', 'a\u3164b', 'a\u2800b']) {
      expect(serverNameProblem(name), JSON.stringify(name)).not.toBeNull();
    }
  });

  it('refuse names wider than the limit', () => {
    expect(serverNameProblem('a'.repeat(SERVER_NAME_MAX_WIDTH + 1))).not.toBeNull();
    expect(serverNameProblem(`${'机'.repeat(SERVER_NAME_MAX_WIDTH / 2)}a`)).not.toBeNull();
  });

  it('stay within the 128 code units the proxy snapshots accept, even when combining marks take no columns', () => {
    const base = { slug: 's1', parentInterface: 'vmbr0', dnsServers: [] };
    expect(zCreateServerRequest.safeParse({ ...base, name: `a${'\u0301'.repeat(127)}` }).success).toBe(true);
    expect(zCreateServerRequest.safeParse({ ...base, name: `a${'\u0301'.repeat(128)}` }).success).toBe(false);
  });

  it('are trimmed and NFC-normalized by the request schemas', () => {
    const base = { slug: 's1', parentInterface: 'vmbr0', dnsServers: [] };
    expect(zCreateServerRequest.parse({ ...base, name: '  Aya 1号机 ' }).name).toBe('Aya 1号机');
    expect(zCreateServerRequest.parse({ ...base, name: 'Cafe\u0301' }).name).toBe('Café');
    expect(zCreateServerRequest.safeParse({ ...base, name: '   ' }).success).toBe(false);
    expect(zPatchServerRequest.safeParse({ expectedRevision: 1, name: 'a\u0007' }).success).toBe(false);
  });
});

describe('container names', () => {
  const request = (name: string) => ({
    serverId: 'srv-1',
    imageId: 'img-1',
    name,
    rootSizeBytes: 1024,
    memBytes: 1024,
    powerIntent: ContainerPowerIntent.Running,
  });

  it('stay host-name shaped and short enough for a prompt', () => {
    expect(zCreateContainerRequest.safeParse(request('web-01')).success).toBe(true);
    expect(zCreateContainerRequest.safeParse(request('a'.repeat(CONTAINER_NAME_MAX_LENGTH))).success).toBe(true);
    expect(zCreateContainerRequest.safeParse(request('a'.repeat(CONTAINER_NAME_MAX_LENGTH + 1))).success).toBe(false);
    expect(zCreateContainerRequest.safeParse(request('-web')).success).toBe(false);
    expect(zCreateContainerRequest.safeParse(request('网站')).success).toBe(false);
  });
});
