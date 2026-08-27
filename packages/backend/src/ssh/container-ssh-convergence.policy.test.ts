import { describe, expect, it } from 'vitest';
import {
  authorizedKeysExpectation,
  authorizedKeysFileMatches,
  sshStatusAfterConvergence,
} from './container-ssh-convergence.policy.js';

describe('Incus authorized_keys convergence policy', () => {
  it('uses the login user path and verifies file metadata plus content hash', () => {
    const expectation = authorizedKeysExpectation({
      loginUser: 'ubuntu',
      publicKey: 'ssh-ed25519 AAAAexample',
    });
    expect(expectation.path).toBe('/home/ubuntu/.ssh/authorized_keys');
    expect(authorizedKeysFileMatches({
      body: expectation.content,
      type: 'file',
      uid: 1000,
      gid: 1000,
      mode: 0o600,
    }, expectation, { uid: 1000, gid: 1000 })).toBe(true);
    expect(authorizedKeysFileMatches({
      body: 'ssh-ed25519 AAAAother\n',
      type: 'file',
      uid: 1000,
      gid: 1000,
      mode: 0o600,
    }, expectation, { uid: 1000, gid: 1000 })).toBe(false);
  });

  it('exposes missing sshd after a successful key write', () => {
    expect(sshStatusAfterConvergence({
      enabled: true,
      containerRunning: true,
      keyApplied: true,
      sshdPresent: false,
    })).toBe('key_applied_sshd_missing');
  });
});
