import { describe, expect, it } from 'vitest';
import { NyabaseConfigService } from '../config/nyabase-config.service.js';
import { IMAGE_ASSIGNMENT_SOURCE } from './image-assignment-reconciler.service.js';
import { NODE_METRICS_PULL, PREFLIGHT_CHECKS, SERVER_TRUST_TOKEN } from './server-preflight-reconciler.service.js';
import { AuthenticatedNodeMetricsPullAdapter } from './node-metrics-pull.adapter.js';
import { IncusPreflightChecksAdapter } from './preflight-checks.adapter.js';
import { RedisDisposableAdapter } from './redis-disposable.adapter.js';
import { RuntimeModule } from './runtime.module.js';
import { CertificateRotationReconciler } from './certificate-rotation-reconciler.service.js';
import { RECONCILER_REGISTRY } from './reconcile-worker.service.js';

describe('RuntimeModule production port wiring', () => {
  it('binds metrics, preflight checks, and trust tokens to concrete adapters', () => {
    const providers = Reflect.getMetadata('providers', RuntimeModule) as Array<{
      provide?: unknown;
      useExisting?: unknown;
    }>;

    expect(providers).toEqual(expect.arrayContaining([
      {
        provide: NODE_METRICS_PULL,
        useExisting: AuthenticatedNodeMetricsPullAdapter,
      },
      {
        provide: PREFLIGHT_CHECKS,
        useExisting: IncusPreflightChecksAdapter,
      },
      {
        provide: SERVER_TRUST_TOKEN,
        useExisting: RedisDisposableAdapter,
      },
    ]));
  });

  it('registers certificate rotation in the worker reconciler registry', () => {
    const providers = Reflect.getMetadata('providers', RuntimeModule) as Array<{
      provide?: unknown;
      useExisting?: unknown;
      useFactory?: (...args: unknown[]) => unknown;
      inject?: unknown[];
    }>;

    expect(providers).toContain(CertificateRotationReconciler);
    expect(providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provide: RECONCILER_REGISTRY,
        inject: expect.arrayContaining([CertificateRotationReconciler]),
      }),
    ]));
  });

  it('binds image assignment pulls to the configured simplestreams source', () => {
    const providers = Reflect.getMetadata('providers', RuntimeModule) as Array<{
      provide?: unknown;
      inject?: unknown[];
      useFactory?: (config: Pick<NyabaseConfigService, 'get'>) => unknown;
    }>;
    const provider = providers.find((entry) => entry.provide === IMAGE_ASSIGNMENT_SOURCE);

    expect(provider).toEqual(expect.objectContaining({
      inject: [NyabaseConfigService],
    }));
    const config = {
      get: (key: string) => {
        if (key === 'incus.imageSourceServer') return '';
        expect(key).toBe('incus.preflightSourceServer');
        return 'https://images.example.test';
      },
    } as unknown as Pick<NyabaseConfigService, 'get'>;
    expect(provider?.useFactory?.(config)).toEqual({
      alias: '',
      fingerprint: null,
      sourceServer: 'https://images.example.test',
    });
    const dedicated = {
      get: (key: string) => {
        if (key === 'incus.imageSourceServer') return 'https://images.internal.test';
        throw new Error(`unexpected config key ${key}`);
      },
    } as unknown as Pick<NyabaseConfigService, 'get'>;
    expect(provider?.useFactory?.(dedicated)).toEqual({
      alias: '',
      fingerprint: null,
      sourceServer: 'https://images.internal.test',
    });
  });
});
