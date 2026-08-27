import { Injectable } from '@nestjs/common';
import {
  IncusError,
  requestAndWait,
  type IncusClientPort,
  type IncusFileResponse,
} from '../incus/index.js';

export const CONTAINER_SSH_STATE = Symbol('CONTAINER_SSH_STATE');

export type SshdPresence = 'present' | 'missing' | 'unknown';

export interface ContainerSshStatePort {
  readHomeDirectoryMetadata(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ readonly uid?: number; readonly gid?: number } | null>;
  readAuthorizedKeys(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<IncusFileResponse | null>;
  writeAuthorizedKeys(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    content: string,
    metadata?: {
      readonly uid?: number;
      readonly gid?: number;
      readonly mode?: number;
      readonly type?: 'file';
    },
    signal?: AbortSignal,
  ): Promise<void>;
  probeSshd(
    client: IncusClientPort,
    instanceName: string,
    signal?: AbortSignal,
  ): Promise<SshdPresence>;
}

const SSHD_PROBE_COMMAND = [
  'bash',
  '-c',
  [
    'if ! command -v sshd >/dev/null 2>&1; then exit 127; fi',
    'if echo >/dev/tcp/127.0.0.1/22 2>/dev/null; then exit 0; fi',
    // Plan D23: image owns sshd; control plane must ensure the service is up.
    'systemctl start ssh 2>/dev/null || systemctl start sshd 2>/dev/null || service ssh start 2>/dev/null || true',
    'for _ in 1 2 3 4 5 6 7 8; do if echo >/dev/tcp/127.0.0.1/22 2>/dev/null; then exit 0; fi; sleep 1; done',
    'exit 2',
  ].join('; '),
] as const;

function isNotFound(error: unknown): boolean {
  return error instanceof IncusError && error.code === 'INCUS_NOT_FOUND';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function operationReturnCode(value: unknown): number | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.return === 'number' && Number.isSafeInteger(value.return)) {
    return value.return;
  }
  return operationReturnCode(value.metadata);
}

function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/\/+$/, '');
  const index = trimmed.lastIndexOf('/');
  if (index <= 0) return null;
  return trimmed.slice(0, index);
}

@Injectable()
export class IncusContainerSshStateAdapter implements ContainerSshStatePort {
  async readHomeDirectoryMetadata(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ readonly uid?: number; readonly gid?: number } | null> {
    try {
      const file = await client.getFile(instanceName, path, { signal });
      return { uid: file.uid, gid: file.gid };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async readAuthorizedKeys(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<IncusFileResponse | null> {
    try {
      return await client.getFile(instanceName, path, { signal });
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async writeAuthorizedKeys(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    content: string,
    metadata?: {
      readonly uid?: number;
      readonly gid?: number;
      readonly mode?: number;
      readonly type?: 'file';
    },
    signal?: AbortSignal,
  ): Promise<void> {
    const parent = parentDirectory(path);
    if (parent) {
      await this.ensureDirectory(client, instanceName, parent, {
        uid: metadata?.uid,
        gid: metadata?.gid,
        mode: 0o700,
      }, signal);
    }
    await client.putFile(instanceName, path, content, {
      uid: metadata?.uid,
      gid: metadata?.gid,
      mode: metadata?.mode ?? 0o600,
      type: metadata?.type ?? 'file',
      write: 'overwrite',
      signal,
    });
  }

  private async ensureDirectory(
    client: IncusClientPort,
    instanceName: string,
    path: string,
    metadata: {
      readonly uid?: number;
      readonly gid?: number;
      readonly mode: number;
    },
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      const existing = await client.getFile(instanceName, path, { signal });
      if (existing.type === 'directory') return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await client.putFile(instanceName, path, Buffer.alloc(0), {
      uid: metadata.uid,
      gid: metadata.gid,
      mode: metadata.mode,
      type: 'directory',
      signal,
    });
  }

  async probeSshd(
    client: IncusClientPort,
    instanceName: string,
    signal?: AbortSignal,
  ): Promise<SshdPresence> {
    let result;
    try {
      result = await requestAndWait(
        client,
        (options) => client.execInstance(
          instanceName,
          {
            command: [...SSHD_PROBE_COMMAND],
            'record-output': false,
          },
          options,
        ),
        { signal },
      );
    } catch (error) {
      // Start/reconcile races: /state can report Running briefly before exec is admitted.
      if (
        error instanceof IncusError
        && (error.code === 'INCUS_BAD_REQUEST' || error.code === 'INSTANCE_BUSY')
        && typeof error.details?.error === 'string'
        && /not running|busy/i.test(error.details.error)
      ) {
        return 'unknown';
      }
      throw error;
    }
    if (result.kind !== 'completed') return 'unknown';
    const code = operationReturnCode(result.metadata);
    if (code === undefined) return 'unknown';
    if (code === 0) return 'present';
    if (code === 127) return 'missing';
    // Exit 2: sshd binary exists but is not accepting connections yet.
    return 'unknown';
  }
}
