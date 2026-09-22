import { describe, expect, it, vi } from 'vitest';
import { IncusContainerSshStateAdapter } from './container-ssh-state.adapter.js';

const instanceName = 'nyc-11111111111141118111111111111111';

describe('IncusContainerSshStateAdapter', () => {
  it('reports sshd absence from the exit status without exposing file content', async () => {
    const client = {
      execInstance: vi.fn().mockResolvedValue({
        status: 202,
        envelope: {
          type: 'async',
          operation: '/1.0/operations/operation-1',
        },
        metadata: undefined,
      }),
      getOperationWait: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
        metadata: { metadata: { return: 127 } },
      }),
    };
    const adapter = new IncusContainerSshStateAdapter();

    await expect(adapter.probeSshd(
      client as never,
      instanceName,
    )).resolves.toBe('missing');
    expect(client.execInstance).toHaveBeenCalledWith(
      instanceName,
      {
        command: [
          'bash',
          '-c',
          [
            'if ! command -v sshd >/dev/null 2>&1; then exit 127; fi',
            'if echo >/dev/tcp/127.0.0.1/22 2>/dev/null; then exit 0; fi',
            'systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || service ssh start 2>/dev/null || true',
            'for _ in 1 2 3 4 5 6 7 8; do if echo >/dev/tcp/127.0.0.1/22 2>/dev/null; then exit 0; fi; sleep 1; done',
            'exit 2',
          ].join('; '),
        ],
        'record-output': false,
      },
      expect.anything(),
    );
  });

  it('maps Incus exec Failure return 127 to sshd missing', async () => {
    const client = {
      execInstance: vi.fn().mockResolvedValue({
        status: 202,
        envelope: {
          type: 'async',
          operation: '/1.0/operations/operation-127',
        },
        metadata: undefined,
      }),
      getOperationWait: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
        metadata: {
          status: 'Failure',
          status_code: 400,
          err: 'Command not found',
          metadata: { return: 127 },
        },
      }),
    };
    const adapter = new IncusContainerSshStateAdapter();
    await expect(adapter.probeSshd(
      client as never,
      instanceName,
    )).resolves.toBe('missing');
  });

  it('reports sshd as unknown while the binary exists but port 22 is closed', async () => {
    const client = {
      execInstance: vi.fn().mockResolvedValue({
        status: 202,
        envelope: {
          type: 'async',
          operation: '/1.0/operations/operation-2',
        },
        metadata: undefined,
      }),
      getOperationWait: vi.fn().mockResolvedValue({
        status: 200,
        envelope: { type: 'sync' },
        metadata: { metadata: { return: 2 } },
      }),
    };
    const adapter = new IncusContainerSshStateAdapter();
    await expect(adapter.probeSshd(client as never, instanceName)).resolves.toBe('unknown');
  });

  it('writes the required file metadata while keeping the key outside logs', async () => {
    const putFile = vi.fn().mockResolvedValue(undefined);
    const getFile = vi.fn().mockResolvedValue({ type: 'directory', uid: 0, gid: 0 });
    const adapter = new IncusContainerSshStateAdapter();
    const content = 'ssh-ed25519 AAAA private-fixture\n';

    await adapter.writeAuthorizedKeys(
      { putFile, getFile } as never,
      instanceName,
      '/root/.ssh/authorized_keys',
      content,
      { uid: 0, gid: 0, mode: 0o600, type: 'file' },
    );

    expect(getFile).toHaveBeenCalledWith(
      instanceName,
      '/root/.ssh',
      expect.anything(),
    );
    expect(putFile).toHaveBeenCalledWith(
      instanceName,
      '/root/.ssh/authorized_keys',
      content,
      expect.objectContaining({
        uid: 0,
        gid: 0,
        mode: 0o600,
        type: 'file',
        write: 'overwrite',
      }),
    );
  });

  it('creates the parent .ssh directory when missing before writing keys', async () => {
    const { IncusError } = await import('../incus/index.js');
    const putFile = vi.fn().mockResolvedValue(undefined);
    const getFile = vi.fn().mockRejectedValue(
      new IncusError('INCUS_NOT_FOUND', 'managed_failure'),
    );
    const adapter = new IncusContainerSshStateAdapter();

    await adapter.writeAuthorizedKeys(
      { putFile, getFile } as never,
      instanceName,
      '/root/.ssh/authorized_keys',
      'ssh-ed25519 AAAA\n',
      { uid: 0, gid: 0, mode: 0o600, type: 'file' },
    );

    expect(putFile).toHaveBeenNthCalledWith(
      1,
      instanceName,
      '/root/.ssh',
      expect.any(Buffer),
      expect.objectContaining({
        uid: 0,
        gid: 0,
        mode: 0o700,
        type: 'directory',
      }),
    );
    expect(putFile).toHaveBeenNthCalledWith(
      2,
      instanceName,
      '/root/.ssh/authorized_keys',
      'ssh-ed25519 AAAA\n',
      expect.objectContaining({ type: 'file', mode: 0o600 }),
    );
  });

  it('reads home directory ownership for non-root authorized keys', async () => {
    const getFile = vi.fn().mockResolvedValue({
      uid: 1000,
      gid: 1000,
    });
    const adapter = new IncusContainerSshStateAdapter();

    await expect(adapter.readHomeDirectoryMetadata(
      { getFile } as never,
      instanceName,
      '/home/nyabase',
    )).resolves.toEqual({ uid: 1000, gid: 1000 });
  });
});
