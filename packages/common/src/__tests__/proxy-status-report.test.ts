import { describe, expect, it } from 'vitest';
import {
  MAX_HTTP_PROXY_ACTIVE_CONNECTIONS,
  MAX_SSH_PROXY_STATUS_CONNECTIONS,
  zHttpProxyStatusReport,
  zSshProxyStatusReport,
} from '../index.js';

function sshStatus(overrides: Record<string, unknown> = {}) {
  return {
    proxyId: 'ssh-proxy-1',
    hostname: null,
    listen: '0.0.0.0:2222',
    uptimeMs: 1,
    connectedAt: 1,
    lastSnapshotGeneration: null,
    lastSnapshotAt: null,
    activeConnections: 0,
    omittedConnections: 0,
    totalConnections: 0,
    totalRejectedConnections: 0,
    totalClosedConnections: 0,
    totalBytesFromClient: 0,
    totalBytesToClient: 0,
    bandwidthInBps: 0,
    bandwidthOutBps: 0,
    connections: [],
    ...overrides,
  };
}

const connection = {
  id: 'conn-1',
  peer: '127.0.0.1:2200',
  username: 'alice',
  login: 'alice.solo',
  serverSlug: null,
  serverId: null,
  containerName: null,
  containerId: null,
  instanceName: null,
  routedIp: null,
  connectedAt: 1,
  authenticatedAt: 2,
  bytesFromClient: 0,
  bytesToClient: 0,
  channels: 0,
};

describe('SSH proxy status report', () => {
  it('accepts a report whose details were truncated and counted as omitted', () => {
    expect(zSshProxyStatusReport.safeParse(sshStatus({
      activeConnections: 3,
      omittedConnections: 2,
      connections: [connection],
    })).success).toBe(true);
    expect(zSshProxyStatusReport.safeParse(sshStatus({
      activeConnections: MAX_SSH_PROXY_STATUS_CONNECTIONS,
      omittedConnections: MAX_SSH_PROXY_STATUS_CONNECTIONS,
    })).success).toBe(true);
  });

  it('rejects counts that do not add up', () => {
    expect(zSshProxyStatusReport.safeParse(sshStatus({
      activeConnections: 3,
      omittedConnections: 1,
      connections: [connection],
    })).success).toBe(false);
    expect(zSshProxyStatusReport.safeParse(sshStatus({ omittedConnections: undefined }))
      .success).toBe(false);
  });
});

describe('HTTP proxy status report', () => {
  it('accepts every connection count the proxy can have', () => {
    const status = {
      proxyId: 'http-proxy-1',
      hostname: null,
      httpListen: '0.0.0.0:80',
      httpsListen: null,
      uptimeMs: 1,
      connectedAt: 1,
      lastSnapshotGeneration: null,
      lastSnapshotAt: null,
      activeConnections: 4_096,
      totalRequests: 10,
      totalRejectedRequests: 0,
    };
    expect(zHttpProxyStatusReport.safeParse(status).success).toBe(true);
    expect(zHttpProxyStatusReport.safeParse({
      ...status,
      activeConnections: MAX_HTTP_PROXY_ACTIVE_CONNECTIONS,
    }).success).toBe(true);
    expect(zHttpProxyStatusReport.safeParse({
      ...status,
      activeConnections: MAX_HTTP_PROXY_ACTIVE_CONNECTIONS + 1,
    }).success).toBe(false);
  });
});
