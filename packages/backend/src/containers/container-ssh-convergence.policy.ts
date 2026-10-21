import { createHash } from 'node:crypto';

export type ContainerSshStatus =
  | 'disabled'
  | 'container_stopped'
  | 'running'
  | 'key_applied_sshd_missing'
  | 'error'
  | 'unknown';

export interface AuthorizedKeysFile {
  readonly body: Uint8Array | string;
  readonly type: string | null;
  readonly uid: number | null;
  readonly gid: number | null;
  readonly mode: number | null;
}

export interface AuthorizedKeysExpectation {
  readonly loginUser: string;
  readonly publicKey: string;
  readonly expectedUid?: number;
  readonly expectedGid?: number;
}

export function authorizedKeysPath(loginUser: string): string {
  assertLoginUser(loginUser);
  return loginUser === 'root'
    ? '/root/.ssh/authorized_keys'
    : `/home/${loginUser}/.ssh/authorized_keys`;
}

export function authorizedKeysContent(publicKey: string): string {
  const content = publicKey.trim();
  if (!content || /[\u0000-\u001f\u007f]/.test(content)) {
    throw new Error('SSH public key is invalid');
  }
  return `${content}\n`;
}

export function authorizedKeysHash(content: Uint8Array | string): string {
  return createHash('sha256')
    .update(typeof content === 'string' ? content : Buffer.from(content))
    .digest('hex');
}

export function authorizedKeysExpectation(
  input: AuthorizedKeysExpectation,
): {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
  readonly mode: number;
} {
  const content = authorizedKeysContent(input.publicKey);
  return {
    path: authorizedKeysPath(input.loginUser),
    content,
    hash: authorizedKeysHash(content),
    mode: 0o600,
  };
}

export function authorizedKeysFileMatches(
  file: AuthorizedKeysFile,
  expectation: ReturnType<typeof authorizedKeysExpectation>,
  owner: { readonly uid?: number; readonly gid?: number } = {},
): boolean {
  return file.type === 'file'
    && file.mode === expectation.mode
    && (owner.uid === undefined || file.uid === owner.uid)
    && (owner.gid === undefined || file.gid === owner.gid)
    && authorizedKeysHash(file.body) === expectation.hash;
}

export function sshStatusAfterConvergence(input: {
  readonly enabled: boolean;
  readonly containerRunning: boolean;
  readonly keyApplied: boolean;
  readonly sshdPresent: boolean | null;
  readonly error?: boolean;
}): ContainerSshStatus {
  if (!input.enabled) return 'disabled';
  if (!input.containerRunning) return 'container_stopped';
  if (input.error) return 'error';
  if (!input.keyApplied) return 'unknown';
  if (input.sshdPresent === false) return 'key_applied_sshd_missing';
  if (input.sshdPresent === true) return 'running';
  return 'unknown';
}

function assertLoginUser(loginUser: string): void {
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(loginUser)) {
    throw new Error('SSH login user is invalid');
  }
}
