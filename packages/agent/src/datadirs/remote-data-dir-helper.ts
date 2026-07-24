import * as fs from 'fs';
import * as path from 'path';
import { DataDirsManager, type DataSource } from './data-dirs.js';
import { parseProcMountInfo } from '../fs/proc-mounts.js';

export interface RemoteDataDirHelperPayload {
  operation: 'list' | 'inspect' | 'create' | 'delete' | 'verifyOwnership' | 'resolve';
  source: DataSource;
  physicalIdentity: string;
  resourceId?: string;
  sourceIdentity?: string;
  uid?: number;
}

function currentMountIdentity(root: string): string | null {
  const exact = parseProcMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'))
    .filter((entry) => path.resolve(entry.mountPoint) === path.resolve(root));
  if (exact.length !== 1) return null;
  const current = exact[0]!;
  return JSON.stringify([
    current.mountId,
    current.parentMountId,
    current.deviceId,
    current.fsRoot,
    current.mountPoint,
    current.fsType,
    current.source,
    current.options,
  ]);
}

async function execute(payload: RemoteDataDirHelperPayload): Promise<unknown> {
  if (!payload || typeof payload !== 'object' || payload.source?.kind !== 'remote') {
    throw new Error('Invalid remote DataDir helper payload');
  }
  const manager = new DataDirsManager(undefined, undefined, undefined, {
    remoteHelperInline: true,
    childProcessDetached: false,
    remoteSourceVerifier: async (source) => {
      const observed = currentMountIdentity(source.root);
      return observed === payload.physicalIdentity ? observed : null;
    },
    physicalMutationLockPath: `/run/nyabase-agent/remote-data-dir-inner-${process.pid}.lock`,
  });
  manager.addSource(payload.source);
  const before = await manager.inspectSourceExact(payload.source.id);
  if (!before.ready || before.physicalIdentity !== payload.physicalIdentity) {
    throw new Error('Remote DataDir source identity does not match before helper work');
  }
  let result: unknown;
  switch (payload.operation) {
    case 'list':
      result = await manager.listAllDirs();
      break;
    case 'inspect':
      result = manager.inspectDir(payload.source.id, requireResourceId(payload));
      break;
    case 'create':
      result = await manager.createDir(
        payload.source.id,
        requireUid(payload),
        requireResourceId(payload),
        requireSourceIdentity(payload),
      );
      break;
    case 'delete':
      await manager.deleteDir(
        payload.source.id,
        requireResourceId(payload),
        requireSourceIdentity(payload),
      );
      result = null;
      break;
    case 'verifyOwnership':
      result = await manager.verifyOwnership(
        payload.source.id,
        requireUid(payload),
        requireResourceId(payload),
        requireSourceIdentity(payload),
      );
      break;
    case 'resolve':
      result = await manager.resolveMountPath(
        payload.source.id,
        requireResourceId(payload),
        requireSourceIdentity(payload),
      );
      break;
    default:
      throw new Error(`Unsupported remote DataDir helper operation ${String(payload.operation)}`);
  }
  const after = await manager.inspectSourceExact(payload.source.id);
  if (!after.ready || after.physicalIdentity !== payload.physicalIdentity) {
    throw new Error('Remote DataDir source identity changed during helper work');
  }
  return result;
}

function requireResourceId(payload: RemoteDataDirHelperPayload): string {
  if (typeof payload.resourceId !== 'string') throw new Error('Remote DataDir helper requires resourceId');
  return payload.resourceId;
}

function requireSourceIdentity(payload: RemoteDataDirHelperPayload): string {
  if (typeof payload.sourceIdentity !== 'string') throw new Error('Remote DataDir helper requires sourceIdentity');
  return payload.sourceIdentity;
}

function requireUid(payload: RemoteDataDirHelperPayload): number {
  if (!Number.isSafeInteger(payload.uid) || (payload.uid ?? -1) < 0) {
    throw new Error('Remote DataDir helper requires a safe uid');
  }
  return payload.uid!;
}

if (require.main === module) {
  void (async () => {
    try {
      const payload = JSON.parse(process.argv[2] ?? '') as RemoteDataDirHelperPayload;
      const data = await execute(payload);
      process.stdout.write(JSON.stringify({ ok: true, data }));
    } catch (error) {
      const record = error as Error & { operation?: unknown };
      process.stdout.write(JSON.stringify({
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
          ...(typeof record.operation === 'string' ? { operation: record.operation } : {}),
        },
      }));
    }
  })();
}
