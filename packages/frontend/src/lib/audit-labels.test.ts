import { describe, expect, it } from 'vitest';
import { AuditAction } from '@nyabase/common';
import { auditActionLabel, auditResourceTypeLabel } from './audit-labels.js';

describe('audit labels', () => {
  it('maps current resource types and does not keep retired mount_source names', () => {
    expect(auditResourceTypeLabel('volume')).toBe('数据卷');
    expect(auditResourceTypeLabel('storage_pool')).toBe('存储池');
    expect(auditResourceTypeLabel('shared_backend')).toBe('共享存储');
    expect(auditResourceTypeLabel('ip_pool')).toBe('IP 池');
    expect(auditResourceTypeLabel('http_proxy_binding')).toBe('HTTP 发布');
    expect(auditResourceTypeLabel('image')).toBe('镜像');
    expect(auditResourceTypeLabel('intent')).toBe('意图');
    expect(auditResourceTypeLabel('datadir')).toBe('datadir');
    expect(auditResourceTypeLabel('mount_source')).toBe('mount_source');
  });

  it('maps grant, container, volume, user, http proxy, ip pool and ssh proxy actions', () => {
    expect(auditActionLabel(AuditAction.UpsertStoragePoolGrant)).toBe('更新存储池授权');
    expect(auditActionLabel(AuditAction.CreateContainer)).toBe('创建容器');
    expect(auditActionLabel(AuditAction.CreateVolume)).toBe('创建数据卷');
    expect(auditActionLabel(AuditAction.CreateUser)).toBe('创建用户');
    expect(auditActionLabel(AuditAction.CreateHttpProxyBinding)).toBe('创建 HTTP 发布');
    expect(auditActionLabel(AuditAction.CreateIpPool)).toBe('创建 IP 池');
    expect(auditActionLabel(AuditAction.DisconnectSshProxySessions)).toBe('断开 SSH 代理会话');
  });
});
