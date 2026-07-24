import { describe, expect, it } from 'vitest';
import {
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
} from '@nyabase/common';
import {
  emptyBindingForm,
  emptyPoolForm,
  validateBindingForm,
  validatePoolForm,
} from './http-proxy-form.js';

describe('HTTP proxy form validation', () => {
  const createContext = { isEditing: false, existingCertificate: null } as const;
  it.each(['', '*', '*.apps.example.com', 'bad..host', 'localhost'])(
    'turns invalid binding hostname %j into a field error without throwing',
    (hostname) => {
      expect(() => validateBindingForm({
        ...emptyBindingForm,
        hostname,
        containerId: 'container-a',
      }, [{ id: 'container-a', name: 'Work' }])).not.toThrow();
      const result = validateBindingForm({
        ...emptyBindingForm,
        hostname,
        containerId: 'container-a',
      }, [{ id: 'container-a', name: 'Work' }]);
      expect(result.payload).toBeNull();
      expect(result.errors.hostname).toBeTruthy();
    },
  );

  it('returns only a canonical valid binding payload', () => {
    expect(validateBindingForm({
      hostname: ' App.Apps.Example.COM. ',
      containerId: 'container-a',
      targetPort: '443',
    }, [{ id: 'container-a', name: 'Work' }])).toEqual({
      errors: {},
      payload: {
        hostname: 'app.apps.example.com',
        containerId: 'container-a',
        targetPort: 443,
      },
    });
  });

  it('distinguishes an unavailable container catalog from a loaded-empty catalog', () => {
    const form = {
      hostname: 'app.apps.example.com',
      containerId: 'stale-container',
      targetPort: '80',
    };
    expect(validateBindingForm(form, null).errors.containerId).toContain('尚未加载');
    expect(validateBindingForm(form, []).errors.containerId).toBe('请选择有效容器');
    expect(validateBindingForm(form, []).payload).toBeNull();
  });

  it.each(['', '*', '*.', '*.bad..example.com', 'bad..example.com'])(
    'turns invalid wildcard domain %j into a field error without throwing',
    (wildcardDomain) => {
      expect(() => validatePoolForm({ ...emptyPoolForm, wildcardDomain }, createContext)).not.toThrow();
      const result = validatePoolForm({ ...emptyPoolForm, wildcardDomain }, createContext);
      expect(result.payload).toBeNull();
      expect(result.errors.wildcardDomain).toBeTruthy();
    },
  );

  it('canonicalizes a valid pool and keeps paired certificate semantics', () => {
    expect(validatePoolForm({
      ...emptyPoolForm,
      wildcardDomain: 'Apps.Example.COM.',
    }, createContext)).toEqual({
      errors: {},
      payload: {
        wildcardDomain: '*.apps.example.com',
        enabled: true,
        httpsEnabled: false,
        certificatePem: null,
        privateKeyPem: null,
      },
    });
    expect(validatePoolForm({
      ...emptyPoolForm,
      wildcardDomain: '*.apps.example.com',
      certificatePem: 'certificate',
    }, createContext).payload).toBeNull();
  });

  it('enforces the HTTPS certificate invariant with existing-certificate context', () => {
    const https = {
      ...emptyPoolForm,
      wildcardDomain: '*.apps.example.com',
      httpsEnabled: true,
    };
    const nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    expect(validatePoolForm(https, { isEditing: false, existingCertificate: null, nowMs }).payload).toBeNull();
    expect(validatePoolForm(https, { isEditing: true, existingCertificate: null, nowMs }).payload).toBeNull();
    expect(validatePoolForm(https, {
      isEditing: true,
      existingCertificate: {
        fingerprint: 'sha256:existing',
        wildcardDomain: '*.apps.example.com',
        notAfter: new Date(nowMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
          + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS + 1).toISOString(),
      },
      nowMs,
    })).toEqual({
      errors: {},
      payload: {
        wildcardDomain: '*.apps.example.com',
        enabled: true,
        httpsEnabled: true,
      },
    });
    expect(validatePoolForm({
      ...https,
      certificatePem: 'certificate',
      privateKeyPem: 'private-key',
    }, { isEditing: false, existingCertificate: null, nowMs }).payload).toMatchObject({
      httpsEnabled: true,
      certificatePem: 'certificate',
      privateKeyPem: 'private-key',
    });
  });

  it('requires a fresh pair when retained certificate domain or exact safe lease differs', () => {
    const nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    const threshold = nowMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS
      + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS;
    const https = {
      ...emptyPoolForm,
      wildcardDomain: '*.apps.example.com',
      httpsEnabled: true,
    };
    const context = (wildcardDomain: string, notAfter: number) => ({
      isEditing: true,
      existingCertificate: {
        fingerprint: 'sha256:existing',
        wildcardDomain,
        notAfter: new Date(notAfter).toISOString(),
      },
      nowMs,
    });
    expect(validatePoolForm(https, context('*.other.example.com', threshold + 10_000)).payload)
      .toBeNull();
    expect(validatePoolForm(https, context('*.apps.example.com', threshold)).payload)
      .toBeNull();
    expect(validatePoolForm(https, context('*.apps.example.com', threshold + 1)).payload)
      .not.toBeNull();
  });

  it('clears an unsafe retained certificate when saving an HTTP-only pool', () => {
    const nowMs = Date.parse('2026-07-17T00:00:00.000Z');
    expect(validatePoolForm({
      ...emptyPoolForm,
      wildcardDomain: '*.new.example.com',
      httpsEnabled: false,
    }, {
      isEditing: true,
      existingCertificate: {
        fingerprint: 'sha256:existing',
        wildcardDomain: '*.old.example.com',
        notAfter: new Date(nowMs + 1_000_000).toISOString(),
      },
      nowMs,
    }).payload).toMatchObject({ certificatePem: null, privateKeyPem: null });
  });
});
