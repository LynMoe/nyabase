import { describe, expect, it } from 'vitest';
import { assertPersistableConnectRequest } from './server-connect-request.js';

const reference = '00000000-0000-4000-8000-000000000001';

describe('assertPersistableConnectRequest', () => {
  it('accepts a bare trust-token reference with optional pin', () => {
    expect(() => assertPersistableConnectRequest({ trustTokenRef: reference })).not.toThrow();
    expect(() => assertPersistableConnectRequest({
      trustTokenRef: reference,
      expectedServerCertFingerprint: 'ab'.repeat(32),
    })).not.toThrow();
  });

  it('requires a UUID reference', () => {
    expect(() => assertPersistableConnectRequest({}))
      .toThrow('require a persistable trust-token reference');
    expect(() => assertPersistableConnectRequest({ trustTokenRef: 'not-a-uuid' }))
      .toThrow('require a persistable trust-token reference');
    expect(() => assertPersistableConnectRequest({ trustTokenRef: 7 }))
      .toThrow('require a persistable trust-token reference');
  });

  it('rejects any field that looks like the token itself, at any depth', () => {
    expect(() => assertPersistableConnectRequest({ trustTokenRef: reference, trustToken: 's' }))
      .toThrow('cannot persist a trust token');
    expect(() => assertPersistableConnectRequest({ trustTokenRef: reference, token: 's' }))
      .toThrow('cannot persist a trust token');
    expect(() => assertPersistableConnectRequest({
      trustTokenRef: reference,
      nested: [{ trust_token: 's' }],
    })).toThrow('cannot persist a trust token');
  });
});
