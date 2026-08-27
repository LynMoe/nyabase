import { describe, expect, it } from 'vitest';
import {
  ContainerStatus,
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  zCreateHttpDomainPoolRequest,
  zCreateHttpProxyBindingRequest,
  zHttpProxySnapshot,
  zPatchHttpDomainPoolRequest,
  zPatchHttpProxyBindingRequest,
} from '@nyabase/common';

describe('HTTP proxy routed identity', () => {
  it('accepts only the routed IP and Incus instance name route fields', () => {
    const snapshot = zHttpProxySnapshot.parse({
      generation: 1,
      createdAt: new Date().toISOString(),
      staleAfterMs: HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
      validUntil: Date.now() + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
      routes: [{
        bindingId: '00000000-0000-4000-8000-000000000001',
        hostname: 'web.example.test',
        domainPoolId: '00000000-0000-4000-8000-000000000002',
        routedIp: '10.20.0.42',
        targetPort: 8080,
        ownerId: '00000000-0000-4000-8000-000000000003',
        containerId: '00000000-0000-4000-8000-000000000004',
        containerName: 'web',
        instanceName: 'nyc-container-1',
        status: ContainerStatus.Running,
      }],
      domainPools: [],
    });

    expect(snapshot.routes[0]).toMatchObject({
      routedIp: '10.20.0.42',
      instanceName: 'nyc-container-1',
    });
    expect(snapshot.routes[0]).not.toHaveProperty('macvlanIp');
    expect(snapshot.routes[0]).not.toHaveProperty('runtimeId');
  });
});

describe('HTTP proxy REST request DTOs', () => {
  it('accepts exact binding create keys and rejects leftovers', () => {
    expect(zCreateHttpProxyBindingRequest.parse({
      hostname: 'app.example.test',
      containerId: 'container-a',
      targetPort: 8080,
    })).toEqual({
      hostname: 'app.example.test',
      containerId: 'container-a',
      targetPort: 8080,
    });
    expect(zCreateHttpProxyBindingRequest.safeParse({
      hostname: 'app.example.test',
      containerId: 'container-a',
      targetPort: 8080,
      runtimeId: 'legacy',
    }).success).toBe(false);
  });

  it('requires at least one binding patch field', () => {
    expect(zPatchHttpProxyBindingRequest.parse({ targetPort: 443 })).toEqual({
      targetPort: 443,
    });
    expect(zPatchHttpProxyBindingRequest.safeParse({}).success).toBe(false);
    expect(zPatchHttpProxyBindingRequest.safeParse({
      targetPort: 80,
      extra: true,
    }).success).toBe(false);
  });

  it('accepts domain pool keys without certificate material and rejects extras', () => {
    expect(zCreateHttpDomainPoolRequest.parse({
      wildcardDomain: '*.example.test',
      enabled: true,
      httpsEnabled: false,
    })).toMatchObject({
      wildcardDomain: '*.example.test',
      enabled: true,
      httpsEnabled: false,
    });
    expect(zCreateHttpDomainPoolRequest.safeParse({
      wildcardDomain: '*.example.test',
      certificatePem: 'not-a-secret',
      extra: true,
    }).success).toBe(false);
    expect(zPatchHttpDomainPoolRequest.safeParse({}).success).toBe(false);
  });
});
