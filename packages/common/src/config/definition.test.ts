import { describe, expect, it } from 'vitest';
import {
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
} from '../constants.js';
import { controlPlaneConfigDefinitions } from './definition.js';

describe('SSH proxy snapshot lease configuration', () => {
  it('bounds leases by snapshot freshness and fail-closed recovery', () => {
    const field = controlPlaneConfigDefinitions.find(
      (definition) => definition.key === 'ssh.proxySnapshotStaleMs',
    );
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MIN_MS - 1).success).toBe(false);
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MIN_MS).success).toBe(true);
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MAX_MS).success).toBe(true);
    expect(field?.schema.safeParse(SSH_PROXY_SNAPSHOT_STALE_MAX_MS + 1).success).toBe(false);
  });
});

describe('proxy token configuration', () => {
  it.each(['http.proxyToken', 'ssh.proxyToken'])('%s accepts only canonical ASCII tokens', (key) => {
    const field = controlPlaneConfigDefinitions.find((definition) => definition.key === key);
    expect(field?.schema.safeParse('').success).toBe(true);
    expect(field?.schema.safeParse('a'.repeat(32)).success).toBe(true);
    expect(field?.schema.safeParse('a'.repeat(31)).success).toBe(false);
    expect(field?.schema.safeParse(`${'a'.repeat(32)} internal`).success).toBe(false);
    expect(field?.schema.safeParse(`é${'a'.repeat(32)}`).success).toBe(false);
  });
});

describe('PostgreSQL and metrics configuration', () => {
  function definition(key: string) {
    return controlPlaneConfigDefinitions.find((item) => item.key === key);
  }

  it('accepts only PostgreSQL URLs for the control-plane database', () => {
    const schema = definition('database.url')?.schema;
    expect(schema?.safeParse('postgresql://nyabase:secret@postgres:5432/nyabase').success).toBe(true);
    expect(schema?.safeParse('postgres://nyabase@localhost/nyabase?sslmode=require').success).toBe(true);
    expect(schema?.safeParse('/data/nyabase.db').success).toBe(false);
    expect(schema?.safeParse('sqlite:///data/nyabase.db').success).toBe(false);
  });

  it('uses one VictoriaMetrics URL for metric ingestion and queries', () => {
    expect(definition('metrics.victoriaMetricsUrl')?.description).toContain('ingestion');
    expect(definition('metrics.victoriaMetricsUrl')?.description).toContain('queries');
  });

  it('keeps the HTTP listen address off the public settings surface', () => {
    const field = definition('server.listenAddress');
    expect(field?.defaultValue).toBe('');
    expect(field?.editable).toBe(false);
    expect(field?.schema.safeParse('127.0.0.1').success).toBe(true);
    expect(field?.schema.safeParse('').success).toBe(true);
  });

  it('trusts no forwarding proxy unless explicitly configured', () => {
    const field = definition('server.trustedProxies');
    expect(field?.defaultValue).toBe('');
    expect(field?.editable).toBe(false);
    for (const value of ['', 'loopback', '10.0.0.1', '10.0.0.0/8, 192.168.1.2', '::1', 'fd00::/8,loopback']) {
      expect(field?.schema.safeParse(value).success, value).toBe(true);
    }
    for (const value of ['true', '*', 'proxy.local', '10.0.0.0/33', '300.1.1.1', 'loopback,']) {
      expect(field?.schema.safeParse(value).success, value).toBe(false);
    }
  });
});

describe('Incus transport and preflight configuration', () => {
  function definition(key: string) {
    return controlPlaneConfigDefinitions.find((item) => item.key === key);
  }

  it('uses bounded configured request and operation wait timeouts', () => {
    const request = definition('incus.requestTimeoutMs')?.schema;
    const operation = definition('incus.operationWaitTimeoutMs')?.schema;
    expect(request?.safeParse(10_000).success).toBe(true);
    expect(request?.safeParse(999).success).toBe(false);
    expect(operation?.safeParse(600_000).success).toBe(true);
    expect(operation?.safeParse(600_001).success).toBe(false);
  });

  it('keeps image alias and immutable fingerprint as distinct settings', () => {
    expect(definition('incus.preflightImageAlias')?.env).toBe('INCUS_PREFLIGHT_IMAGE_ALIAS');
    expect(definition('incus.preflightImageFingerprint')?.env)
      .toBe('INCUS_PREFLIGHT_IMAGE_FINGERPRINT');
    expect(definition('incus.preflightImageFingerprint')?.schema.safeParse('ubuntu/24.04').success)
      .toBe(false);
    expect(definition('incus.preflightImageFingerprint')?.schema.safeParse('a'.repeat(64)).success)
      .toBe(true);
    expect(definition('incus.preflightSourceServer')?.defaultValue)
      .toBe('https://nyabase-images.nyabase-lxc-images.workers.dev');
    expect(definition('incus.imageSourceServer')?.env).toBe('INCUS_IMAGE_SOURCE_URL');
    expect(definition('incus.imageSourceServer')?.defaultValue)
      .toBe('https://nyabase-images.nyabase-lxc-images.workers.dev');
    expect(definition('incus.imageSourceServer')?.schema.safeParse('').success).toBe(true);
    expect(definition('incus.imageSourceServer')?.schema.safeParse('https://images.example.test').success)
      .toBe(true);
    expect(definition('incus.imageSourceServer')?.schema.safeParse('http://insecure.example.test').success)
      .toBe(false);
  });

  it('has no Incus TLS inputs: the Backend reaches Incus only through host agents', () => {
    expect(definition('incus.caFile')).toBeUndefined();
    expect(definition('incus.caPem')).toBeUndefined();
    expect(definition('incus.clientCertificateFile')).toBeUndefined();
    expect(definition('incus.clientPrivateKeyPem')).toBeUndefined();
  });

  it('keeps the uniform container limits online-editable', () => {
    for (const key of [
      'containers.processLimit',
      'containers.networkIngressMbit',
      'containers.networkEgressMbit',
      'containers.diskReadMBps',
      'containers.diskWriteMBps',
    ]) {
      expect(definition(key)?.editable).toBe(true);
      expect(definition(key)?.restartRequired).toBe(false);
    }
  });
});
