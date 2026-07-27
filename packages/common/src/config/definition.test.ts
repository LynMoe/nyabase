import { describe, expect, it } from 'vitest';
import {
  SSH_PROXY_SNAPSHOT_STALE_MAX_MS,
  SSH_PROXY_SNAPSHOT_STALE_MIN_MS,
} from '../constants.js';
import { controlPlaneConfigDefinitions } from './definition.js';

describe('SSH proxy snapshot lease configuration', () => {
  it('bounds leases by Agent report freshness and fail-closed recovery', () => {
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

describe('PostgreSQL, Redis, and metrics configuration', () => {
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

  it('keeps Redis disposable and separates metric reads from writes in the manifest', () => {
    expect(definition('redis.url')?.defaultValue).toBe('redis://redis:6379/0');
    expect(definition('metrics.victoriaMetricsUrl')?.description).toContain('queries');
    expect(definition('metrics.vmagentUrl')?.description).toContain('ingestion');
  });

  it('accepts only the bounded canonical Redis URL subset used by the runtime', () => {
    const schema = definition('redis.url')?.schema;
    for (const value of [
      'redis://redis:6379/0',
      'rediss://nyabase:p%40ss@redis.internal:6380/15',
      'redis://:password@[::1]:6379/2147483647',
    ]) {
      expect(schema?.safeParse(value).success, value).toBe(true);
    }

    for (const value of [
      'redis:///0',
      'redis://redis',
      'redis://redis/',
      'redis://redis/-1',
      'redis://redis/01',
      'redis://redis/2147483648',
      'redis://redis/0/extra',
      'redis://user@redis/0',
      'redis://user name:password@redis/0',
      `redis://user:${'p'.repeat(1_025)}@redis/0`,
      'redis://redis/0?tls=true',
      'rediss://redis/0?rejectUnauthorized=false',
      'redis://redis/0#fragment',
      'http://redis/0',
    ]) {
      expect(schema?.safeParse(value).success, value).toBe(false);
    }
  });

  it('supports a simple all-in-one default and independently scalable runtime roles', () => {
    const schema = definition('runtime.role')?.schema;
    expect(definition('runtime.role')?.defaultValue).toBe('all');
    for (const role of ['all', 'api', 'gateway', 'worker']) {
      expect(schema?.safeParse(role).success).toBe(true);
    }
    expect(schema?.safeParse('scheduler').success).toBe(false);
  });

  it('accepts only an exact credential-free Console owner WebSocket URL', () => {
    const schema = definition('runtime.consolePublicUrl')?.schema;
    expect(schema?.safeParse('').success).toBe(true);
    expect(schema?.safeParse('wss://gateway-b.example/ws/console').success).toBe(true);
    expect(schema?.safeParse('ws://127.0.0.1:3001/ws/console').success).toBe(true);
    expect(schema?.safeParse('/ws/console').success).toBe(false);
    expect(schema?.safeParse('https://gateway-b.example/ws/console').success).toBe(false);
    expect(schema?.safeParse('wss://user:secret@gateway-b.example/ws/console').success).toBe(false);
    expect(schema?.safeParse('wss://gateway-b.example/ws/console?target=a').success).toBe(false);
    expect(schema?.safeParse('wss://gateway-b.example/ws/console/extra').success).toBe(false);
    expect(schema?.safeParse(
      `wss://${'a'.repeat(2_048)}.example/ws/console`,
    ).success).toBe(false);
  });
});
