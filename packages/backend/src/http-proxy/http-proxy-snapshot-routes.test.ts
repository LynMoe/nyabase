import { describe, expect, it } from 'vitest';
import { routableBindings, type SnapshotInputs } from './http-proxy-snapshot.service.js';

const OWNER = '00000000-0000-4000-8000-000000000001';
const OTHER_OWNER = '00000000-0000-4000-8000-000000000002';
const SERVER = '00000000-0000-4000-8000-000000000010';
const CONTAINER = '00000000-0000-4000-8000-000000000020';
const OTHER_CONTAINER = '00000000-0000-4000-8000-000000000021';
const POOL = '00000000-0000-4000-8000-000000000030';
const BINDING = '00000000-0000-4000-8000-000000000040';
const INSTANCE = `nyc-${'a'.repeat(32)}`;
const ADDRESS = '10.20.0.42';
const LONG_AGO = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

type Overrides = {
  server?: Record<string, unknown>;
  container?: Record<string, unknown>;
  route?: Record<string, unknown>;
  claims?: Record<string, unknown>[];
  bindings?: Record<string, unknown>[];
  users?: Record<string, unknown>[];
  access?: string[];
};

/** One running container behind one binding, as seen while its agent is down. */
function inputs(overrides: Overrides = {}): SnapshotInputs {
  return {
    bindings: overrides.bindings ?? [{
      id: BINDING,
      hostname: 'web.example.test',
      domain_pool_id: POOL,
      container_id: CONTAINER,
      owner_id: OWNER,
      target_port: 8080,
    }],
    pools: [{
      id: POOL,
      wildcard_domain: '*.example.test',
      enabled: true,
      https_enabled: false,
      certificate_pem: null,
      encrypted_private_key_pem: null,
    }],
    containers: [{
      id: CONTAINER,
      name: 'web',
      owner_id: OWNER,
      server_id: SERVER,
      instance_name: INSTANCE,
      lifecycle_phase: 'active',
      power_intent: 'running',
      ...overrides.container,
    }],
    routes: [{
      container_id: CONTAINER,
      server_id: SERVER,
      instance_name: INSTANCE,
      routed_ip: ADDRESS,
      instance_status: 'running',
      observed_at: LONG_AGO,
      ...overrides.route,
    }],
    users: overrides.users ?? [{ id: OWNER, status: 'active' }],
    servers: [{
      id: SERVER,
      status: 'unreachable',
      parent_interface: 'eth0',
      ...overrides.server,
    }],
    addressClaims: overrides.claims ?? [{
      address: ADDRESS,
      owner_kind: 'container',
      owner_id: CONTAINER,
      container_id: CONTAINER,
      server_id: SERVER,
      state: 'active',
    }],
    usableAccess: new Set(overrides.access ?? [`${OWNER}\0${SERVER}`]),
  } as unknown as SnapshotInputs;
}

describe('routableBindings', () => {
  it('keeps serving a site while the server agent is disconnected and observations are old', () => {
    expect(routableBindings(inputs())).toEqual([expect.objectContaining({
      bindingId: BINDING,
      routedIp: ADDRESS,
      containerId: CONTAINER,
      instanceName: INSTANCE,
    })]);
    expect(routableBindings(inputs({ server: { status: 'unknown' } }))).toHaveLength(1);
  });

  it('drops the route once the container is observed stopped or is no longer wanted running', () => {
    expect(routableBindings(inputs({ route: { instance_status: 'stopped' } }))).toEqual([]);
    expect(routableBindings(inputs({ container: { power_intent: 'stopped' } }))).toEqual([]);
    expect(routableBindings(inputs({ container: { lifecycle_phase: 'deleting' } }))).toEqual([]);
  });

  it('never routes to an address that is not claimed by exactly this container', () => {
    // Released (container gone): the address is parked for runtime cleanup.
    expect(routableBindings(inputs({
      claims: [{
        address: ADDRESS,
        owner_kind: 'runtime_cleanup',
        owner_id: CONTAINER,
        container_id: null,
        server_id: SERVER,
        state: 'releasing',
      }],
    }))).toEqual([]);
    // Claimed by another tenant's container.
    expect(routableBindings(inputs({
      claims: [{
        address: ADDRESS,
        owner_kind: 'container',
        owner_id: OTHER_CONTAINER,
        container_id: OTHER_CONTAINER,
        server_id: SERVER,
        state: 'active',
      }],
    }))).toEqual([]);
    // No claim at all.
    expect(routableBindings(inputs({ claims: [] }))).toEqual([]);
  });

  it('drops the route when the binding, owner or server access goes away', () => {
    expect(routableBindings(inputs({ bindings: [] }))).toEqual([]);
    expect(routableBindings(inputs({ users: [] }))).toEqual([]);
    expect(routableBindings(inputs({ access: [] }))).toEqual([]);
    expect(routableBindings(inputs({
      bindings: [{
        id: BINDING,
        hostname: 'web.example.test',
        domain_pool_id: POOL,
        container_id: CONTAINER,
        owner_id: OTHER_OWNER,
        target_port: 8080,
      }],
      users: [{ id: OWNER, status: 'active' }, { id: OTHER_OWNER, status: 'active' }],
    }))).toEqual([]);
    expect(routableBindings(inputs({ server: { parent_interface: null } }))).toEqual([]);
  });
});
