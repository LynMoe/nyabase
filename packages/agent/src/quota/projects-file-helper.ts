import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import * as childProcess from 'child_process';
import {
  PHYSICAL_MUTATION_LOCK_PATH,
  ensurePhysicalMutationFence,
} from '../physical-mutation-fence.js';

// Keep the values used by the stringified child entry points in non-exported
// bindings. TypeScript rewrites references to exported CommonJS bindings as
// `exports.<name>`; that object is empty when the function body is later run
// via `node -e`, which previously turned the helper path and ambiguity exit
// code into `undefined` in the production build.
const PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL = 76;
const ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL =
  '/opt/nyabase-agent/bin/nyabase-atomic-file-exchange';

export const PROJECTS_FILE_AMBIGUITY_EXIT_CODE = PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL;
export const ATOMIC_FILE_EXCHANGE_HELPER_PATH = ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL;

export interface ProjectsFileSnapshot {
  exists: boolean;
  contents: string;
  mode: number;
  identity: {
    dev: string;
    ino: string;
    mode: string;
    uid: string;
    gid: string;
    nlink: string;
    size: string;
    mtimeNs: string;
    ctimeNs: string;
    digest: string;
  } | null;
}

export interface ProjectsFileMutationResult {
  projectId: number | null;
  changed: boolean;
}

export interface ProjectsFileMutationOptions {
  /** Deterministic race seam. Production never supplies this callback. */
  beforePublish?: () => void;
  /** Runs after the final safe read and immediately before atomic exchange. */
  beforeExchange?: () => void;
  /** Crash-recovery seams. Production never supplies these callbacks. */
  afterJournal?: () => void;
  afterExchange?: () => void;
  afterVerify?: () => void;
  afterCleanup?: () => void;
  /** Test-only compiled helper seam; production uses the fixed installed path. */
  exchangeHelperPath?: string;
}

interface ProjectsFileTransaction {
  version: 1;
  projectsPath: string;
  temporaryPath: string;
  phase: 'prepared' | 'exchanged' | 'verified' | 'rollback';
  original: ProjectsFileSnapshot;
  candidate: ProjectsFileSnapshot;
  captured?: ProjectsFileSnapshot;
}

type BigStat = ReturnType<typeof fs.lstatSync> & {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  uid: bigint;
  gid: bigint;
  nlink: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
};

function projectsStatIdentity(stat: BigStat, digest: string) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: String(stat.mode),
    uid: String(stat.uid),
    gid: String(stat.gid),
    nlink: String(stat.nlink),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    digest,
  };
}

function projectsIdentityEqual(
  left: NonNullable<ProjectsFileSnapshot['identity']>,
  right: NonNullable<ProjectsFileSnapshot['identity']>,
): boolean {
  return Object.keys(left).every((key) =>
    left[key as keyof typeof left] === right[key as keyof typeof right]);
}

function projectsSnapshotEqual(
  left: ProjectsFileSnapshot,
  right: ProjectsFileSnapshot,
): boolean {
  if (
    left.exists !== right.exists
    || left.contents !== right.contents
    || left.mode !== right.mode
  ) return false;
  if (!left.identity || !right.identity) return left.identity === right.identity;
  // renameat2(RENAME_EXCHANGE) may advance inode ctime solely because its
  // namespace link changed. All content/ownership/link/mode fields, including
  // mtime and digest, must remain exact across publication.
  return [
    'dev',
    'ino',
    'mode',
    'uid',
    'gid',
    'nlink',
    'size',
    'mtimeNs',
    'digest',
  ].every((key) => left.identity![key as keyof typeof left.identity]
    === right.identity![key as keyof typeof right.identity]);
}

function fsyncProjectsDirectoryWithModules(directory: string, fsModule: typeof fs): void {
  const directoryFd = fsModule.openSync(
    directory,
    fsModule.constants.O_RDONLY | fsModule.constants.O_DIRECTORY,
  );
  try {
    fsModule.fsyncSync(directoryFd);
  } finally {
    fsModule.closeSync(directoryFd);
  }
}

function projectsJournalPathWithModules(projectsPath: string, pathModule: typeof path): string {
  return pathModule.join(
    pathModule.dirname(projectsPath),
    `.${pathModule.basename(projectsPath)}.nyabase-transaction.json`,
  );
}

function validateProjectsTransactionWithModules(
  value: unknown,
  projectsPath: string,
  pathModule: typeof path,
): ProjectsFileTransaction {
  const transaction = value as ProjectsFileTransaction;
  const validSnapshot = (snapshot: ProjectsFileSnapshot | undefined): boolean => Boolean(
    snapshot
    && typeof snapshot.exists === 'boolean'
    && typeof snapshot.contents === 'string'
    && Number.isInteger(snapshot.mode)
    && snapshot.mode >= 0
    && snapshot.mode <= 0o777
    && (snapshot.exists
      ? snapshot.identity
        && Object.values(snapshot.identity).every((field) => typeof field === 'string')
      : snapshot.identity === null),
  );
  if (
    !transaction
    || transaction.version !== 1
    || transaction.projectsPath !== projectsPath
    || !['prepared', 'exchanged', 'verified', 'rollback'].includes(transaction.phase)
    || typeof transaction.temporaryPath !== 'string'
    || pathModule.dirname(transaction.temporaryPath) !== pathModule.dirname(projectsPath)
    || !pathModule.basename(transaction.temporaryPath).startsWith(
      `.${pathModule.basename(projectsPath)}.nyabase-`,
    )
    || !pathModule.basename(transaction.temporaryPath).endsWith('.tmp')
    || !validSnapshot(transaction.original)
    || !validSnapshot(transaction.candidate)
    || (transaction.captured !== undefined && !validSnapshot(transaction.captured))
    || (transaction.phase === 'rollback' && !transaction.captured)
  ) {
    throw new Error(`[projects-file] invalid recovery journal for ${projectsPath}`);
  }
  return transaction;
}

function writeProjectsTransactionWithModules(
  transaction: ProjectsFileTransaction,
  fsModule: typeof fs,
  cryptoModule: typeof crypto,
  pathModule: typeof path,
): void {
  const journalPath = projectsJournalPathWithModules(transaction.projectsPath, pathModule);
  const stagingPath = `${journalPath}.${process.pid}-${cryptoModule.randomBytes(8).toString('hex')}.tmp`;
  const contents = `${JSON.stringify(transaction)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > 64 * 1024 * 1024) {
    throw new Error('[projects-file] recovery journal exceeds bounded size');
  }
  let fd: number | null = null;
  try {
    fd = fsModule.openSync(stagingPath, 'wx', 0o600);
    fsModule.writeFileSync(fd, contents, 'utf8');
    fsModule.fchownSync(fd, 0, 0);
    fsModule.fchmodSync(fd, 0o600);
    fsModule.fsyncSync(fd);
    fsModule.closeSync(fd);
    fd = null;
    fsModule.renameSync(stagingPath, journalPath);
    fsyncProjectsDirectoryWithModules(pathModule.dirname(journalPath), fsModule);
  } catch (error) {
    if (fd !== null) try { fsModule.closeSync(fd); } catch { /* best effort */ }
    try { fsModule.unlinkSync(stagingPath); } catch { /* best effort */ }
    throw error;
  }
}

function removeProjectsJournalWithModules(
  projectsPath: string,
  fsModule: typeof fs,
  pathModule: typeof path,
): void {
  fsModule.unlinkSync(projectsJournalPathWithModules(projectsPath, pathModule));
  fsyncProjectsDirectoryWithModules(pathModule.dirname(projectsPath), fsModule);
}

function runAtomicFileExchangeHelperWithModules(
  args: string[],
  helperPath: string,
  fsModule: typeof fs,
  pathModule: typeof path,
  childProcessModule: typeof childProcess,
  lockPath?: string,
): void {
  if (!pathModule.isAbsolute(helperPath) || pathModule.resolve(helperPath) !== helperPath) {
    throw new Error('[projects-file] invalid atomic exchange helper path');
  }
  const pathStat = fsModule.lstatSync(helperPath);
  const helperFd = fsModule.openSync(
    helperPath,
    fsModule.constants.O_RDONLY | fsModule.constants.O_NOFOLLOW,
  );
  try {
    const openedStat = fsModule.fstatSync(helperFd);
    if (
      !pathStat.isFile()
      || pathStat.isSymbolicLink()
      || pathStat.uid !== 0
      || pathStat.gid !== 0
      || pathStat.nlink !== 1
      || (pathStat.mode & 0o022) !== 0
      || pathStat.dev !== openedStat.dev
      || pathStat.ino !== openedStat.ino
      || !openedStat.isFile()
    ) {
      throw new Error(`[projects-file] unsafe atomic exchange helper ${helperPath}`);
    }
    // Execute the already-verified inode, not a path that can be replaced
    // between provenance validation and execve.
    childProcessModule.execFileSync(
      lockPath ? '/usr/bin/flock' : '/proc/self/fd/3',
      lockPath
        ? ['--exclusive', '--no-fork', lockPath, '/proc/self/fd/3', ...args]
        : args,
      {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe', helperFd],
      },
    );
  } finally {
    fsModule.closeSync(helperFd);
  }
}

function exchangeProjectsPathsWithModules(
  left: string,
  right: string,
  helperPath: string,
  fsModule: typeof fs,
  pathModule: typeof path,
  childProcessModule: typeof childProcess,
): void {
  if (pathModule.dirname(left) !== pathModule.dirname(right)) {
    throw new Error('[projects-file] atomic exchange requires one directory');
  }
  runAtomicFileExchangeHelperWithModules(
    [left, right],
    helperPath,
    fsModule,
    pathModule,
    childProcessModule,
  );
}

function readProjectsFileSnapshotWithModules(
  projectsPath: string,
  fsModule: typeof fs,
  cryptoModule: typeof crypto,
): ProjectsFileSnapshot {
  let pathStat: BigStat;
  try {
    pathStat = fsModule.lstatSync(projectsPath, { bigint: true }) as BigStat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, contents: '', mode: 0o644, identity: null };
    }
    throw error;
  }
  if (
    !pathStat.isFile()
    || pathStat.isSymbolicLink()
    || pathStat.uid !== 0n
    || pathStat.gid !== 0n
    || pathStat.nlink !== 1n
    || (pathStat.mode & 0o022n) !== 0n
  ) {
    throw new Error(`[projects-file] unsafe projects file ${projectsPath}`);
  }

  const fd = fsModule.openSync(
    projectsPath,
    fsModule.constants.O_RDONLY | fsModule.constants.O_NOFOLLOW,
  );
  try {
    const openedStat = fsModule.fstatSync(fd, { bigint: true }) as BigStat;
    const contents = fsModule.readFileSync(fd, 'utf8');
    const completedStat = fsModule.fstatSync(fd, { bigint: true }) as BigStat;
    const completedPathStat = fsModule.lstatSync(projectsPath, { bigint: true }) as BigStat;
    const digest = cryptoModule.createHash('sha256').update(contents).digest('hex');
    const pathIdentity = projectsStatIdentity(pathStat, digest);
    const openedIdentity = projectsStatIdentity(openedStat, digest);
    const completedIdentity = projectsStatIdentity(completedStat, digest);
    const completedPathIdentity = projectsStatIdentity(completedPathStat, digest);
    if (
      !projectsIdentityEqual(pathIdentity, openedIdentity)
      || !projectsIdentityEqual(openedIdentity, completedIdentity)
      || !projectsIdentityEqual(completedIdentity, completedPathIdentity)
      || !completedPathStat.isFile()
      || completedPathStat.isSymbolicLink()
      || completedPathStat.uid !== 0n
      || completedPathStat.gid !== 0n
      || completedPathStat.nlink !== 1n
      || (completedPathStat.mode & 0o022n) !== 0n
      || BigInt(Buffer.byteLength(contents, 'utf8')) !== completedStat.size
    ) {
      throw new Error(`[projects-file] projects file changed while reading ${projectsPath}`);
    }
    return {
      exists: true,
      contents,
      mode: Number(pathStat.mode & 0o777n),
      identity: completedIdentity,
    };
  } finally {
    fsModule.closeSync(fd);
  }
}

function recoverProjectsFileTransactionWithModules(
  projectsPath: string,
  fsModule: typeof fs,
  cryptoModule: typeof crypto,
  pathModule: typeof path,
  childProcessModule: typeof childProcess,
  exchangeHelperPath: string,
): void {
  const journalPath = projectsJournalPathWithModules(projectsPath, pathModule);
  const recoveryRead = (filePath: string): ProjectsFileSnapshot => {
    try {
      return readProjectsFileSnapshotWithModules(filePath, fsModule, cryptoModule);
    } catch (error) {
      if (error && typeof error === 'object') {
        Object.assign(error, { projectsFileAmbiguous: true });
      }
      throw error;
    }
  };
  const journalSnapshot = recoveryRead(journalPath);
  if (!journalSnapshot.exists) return;
  if (
    journalSnapshot.mode !== 0o600
    || Buffer.byteLength(journalSnapshot.contents, 'utf8') > 64 * 1024 * 1024
  ) {
    throw Object.assign(
      new Error(`[projects-file] unsafe recovery journal ${journalPath}`),
      { projectsFileAmbiguous: true },
    );
  }

  let transaction: ProjectsFileTransaction;
  try {
    transaction = validateProjectsTransactionWithModules(
      JSON.parse(journalSnapshot.contents),
      projectsPath,
      pathModule,
    );
  } catch (error) {
    throw Object.assign(
      new Error(`[projects-file] cannot validate recovery journal ${journalPath}: ${
        error instanceof Error ? error.message : String(error)
      }`),
      { projectsFileAmbiguous: true },
    );
  }

  const target = recoveryRead(projectsPath);
  const temporary = recoveryRead(transaction.temporaryPath);
  const targetIs = (snapshot: ProjectsFileSnapshot) => projectsSnapshotEqual(target, snapshot);
  const temporaryIs = (snapshot: ProjectsFileSnapshot) => projectsSnapshotEqual(temporary, snapshot);
  const cleanup = (removeTemporary: boolean) => {
    if (removeTemporary) fsModule.unlinkSync(transaction.temporaryPath);
    removeProjectsJournalWithModules(projectsPath, fsModule, pathModule);
  };

  // Journal durable, exchange not performed: abandon the candidate. A target
  // deletion that won before exchange is equally safe to preserve as absent.
  if (
    temporaryIs(transaction.candidate)
    && (targetIs(transaction.original) || (!target.exists && transaction.original.exists))
  ) {
    cleanup(true);
    return;
  }

  // Exchange completed: target is the verified candidate and the old inode is
  // still durably retained under the transaction's unique temporary name.
  if (targetIs(transaction.candidate) && temporaryIs(transaction.original)) {
    cleanup(true);
    return;
  }

  // Candidate cleanup completed but the final journal unlink did not.
  if (targetIs(transaction.candidate) && !temporary.exists) {
    cleanup(false);
    return;
  }

  // A rollback record binds the exact concurrent winner before exchanging it
  // back, so either side of a crash during rollback is mechanically provable.
  if (transaction.phase === 'rollback' && transaction.captured) {
    if (targetIs(transaction.candidate) && temporaryIs(transaction.captured)) {
      try {
        exchangeProjectsPathsWithModules(
          transaction.temporaryPath,
          projectsPath,
          exchangeHelperPath,
          fsModule,
          pathModule,
          childProcessModule,
        );
      } catch (error) {
        if (error && typeof error === 'object') {
          Object.assign(error, { projectsFileAmbiguous: true });
        }
        throw error;
      }
      fsyncProjectsDirectoryWithModules(pathModule.dirname(projectsPath), fsModule);
      const restored = recoveryRead(projectsPath);
      const candidate = recoveryRead(transaction.temporaryPath);
      if (
        !projectsSnapshotEqual(restored, transaction.captured)
        || !projectsSnapshotEqual(candidate, transaction.candidate)
      ) {
        throw Object.assign(
          new Error(`[projects-file] rollback recovery verification failed for ${projectsPath}`),
          { projectsFileAmbiguous: true },
        );
      }
      cleanup(true);
      return;
    }
    if (targetIs(transaction.captured) && temporaryIs(transaction.candidate)) {
      cleanup(true);
      return;
    }
  }

  // Nothing else can be decided without risking an external writer. Preserve
  // target, candidate/original, and journal for operator recovery and fail-stop.
  throw Object.assign(
    new Error(
      `[projects-file] ambiguous recovery state for ${projectsPath}; retained ${transaction.temporaryPath} and ${journalPath}`,
    ),
    { projectsFileAmbiguous: true },
  );
}

function mutateProjectsFileWithModules(
  operation: 'ensure' | 'remove',
  expectedText: string,
  durablePath: string,
  projectsPath: string,
  fsModule: typeof fs,
  cryptoModule: typeof crypto,
  pathModule: typeof path,
  childProcessModule: typeof childProcess,
  beforePublish?: () => void,
  beforeExchange?: () => void,
  afterJournal?: () => void,
  afterExchange?: () => void,
  afterVerify?: () => void,
  afterCleanup?: () => void,
  exchangeHelperPath = ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL,
): ProjectsFileMutationResult {
  const offset = 10_000;
  const maxProjectId = 0xffff_ffff;
  const fail = (message: string): never => {
    throw new Error(`[projects-file] ${message}`);
  };
  if (operation !== 'ensure' && operation !== 'remove') fail(`unsupported operation ${operation}`);
  if (
    typeof durablePath !== 'string'
    || durablePath.includes('\0')
    || durablePath.includes('\r')
    || durablePath.includes('\n')
    || !pathModule.isAbsolute(durablePath)
    || pathModule.resolve(durablePath) !== durablePath
  ) fail('invalid durable path');
  const expectedProjectId = expectedText === '*' ? null : Number(expectedText);
  if (
    expectedProjectId !== null
    && (!Number.isSafeInteger(expectedProjectId)
      || expectedProjectId <= offset
      || expectedProjectId > maxProjectId
      || String(expectedProjectId) !== expectedText)
  ) fail(`invalid expected project id ${expectedText}`);

  recoverProjectsFileTransactionWithModules(
    projectsPath,
    fsModule,
    cryptoModule,
    pathModule,
    childProcessModule,
    exchangeHelperPath,
  );
  const initial = readProjectsFileSnapshotWithModules(projectsPath, fsModule, cryptoModule);
  const lines = initial.contents.split('\n');
  const matches = lines.flatMap((line: string, lineIndex: number) => {
    const separator = line.indexOf(':');
    if (separator < 0 || line.slice(separator + 1) !== durablePath) return [];
    return [{ projectText: line.slice(0, separator), lineIndex }];
  });
  if (matches.length > 1) fail(`ambiguous duplicate registrations (${matches.length})`);
  const current = matches[0];
  let currentProjectId: number | null = null;
  if (current) {
    if (!/^\d+$/.test(current.projectText)) fail(`malformed project id ${JSON.stringify(current.projectText)}`);
    currentProjectId = Number(current.projectText);
    if (
      !Number.isSafeInteger(currentProjectId)
      || currentProjectId <= offset
      || currentProjectId > maxProjectId
      || String(currentProjectId) !== current.projectText
    ) fail(`non-Nyabase project id ${current.projectText}`);
    if (expectedProjectId !== null && currentProjectId !== expectedProjectId) {
      fail(`path belongs to project ${currentProjectId}, expected ${expectedProjectId}`);
    }
  }

  let next: string | null = null;
  if (operation === 'ensure') {
    if (expectedProjectId === null) fail('ensure requires an expected project id');
    if (!current) {
      const separator = initial.contents.length > 0 && !initial.contents.endsWith('\n') ? '\n' : '';
      next = `${initial.contents}${separator}${expectedProjectId}:${durablePath}\n`;
    }
  } else if (current) {
    next = lines.filter((_line: string, index: number) => index !== current.lineIndex).join('\n');
  }

  if (next === null) return { projectId: currentProjectId, changed: false };

  const directory = pathModule.dirname(projectsPath);
  const temporaryPath = pathModule.join(
    directory,
    `.${pathModule.basename(projectsPath)}.nyabase-${process.pid}-${cryptoModule.randomBytes(8).toString('hex')}.tmp`,
  );
  let fd: number | null = null;
  let temporaryExists = false;
  let preserveTemporary = false;
  let journalActive = false;
  let transaction: ProjectsFileTransaction | null = null;
  try {
    fd = fsModule.openSync(temporaryPath, 'wx', initial.mode);
    temporaryExists = true;
    fsModule.writeFileSync(fd, next, 'utf8');
    fsModule.fchownSync(fd, 0, 0);
    fsModule.fchmodSync(fd, initial.mode);
    fsModule.fsyncSync(fd);
    fsModule.closeSync(fd);
    fd = null;
    const prepared = readProjectsFileSnapshotWithModules(
      temporaryPath,
      fsModule,
      cryptoModule,
    );

    beforePublish?.();
    const immediatelyBeforePublish = readProjectsFileSnapshotWithModules(
      projectsPath,
      fsModule,
      cryptoModule,
    );
    if (initial.exists) {
      if (
        !immediatelyBeforePublish.exists
        || !initial.identity
        || !immediatelyBeforePublish.identity
        || !projectsIdentityEqual(initial.identity, immediatelyBeforePublish.identity)
        || initial.contents !== immediatelyBeforePublish.contents
      ) fail(`projects file changed before publish ${projectsPath}`);
      transaction = {
        version: 1,
        projectsPath,
        temporaryPath,
        phase: 'prepared',
        original: initial,
        candidate: prepared,
      };
      preserveTemporary = true;
      writeProjectsTransactionWithModules(transaction, fsModule, cryptoModule, pathModule);
      journalActive = true;
      afterJournal?.();
      beforeExchange?.();
      // Capture the exact namespace entry being replaced in the temporary
      // name. Only the atomic exchange has no final read-to-rename gap.
      // Mark it as recovery *before* invoking the wrapper: renameat2 may have
      // completed even if the wrapper transport/timeout is not observable.
      preserveTemporary = true;
      exchangeProjectsPathsWithModules(
        temporaryPath,
        projectsPath,
        exchangeHelperPath,
        fsModule,
        pathModule,
        childProcessModule,
      );
      transaction.phase = 'exchanged';
      writeProjectsTransactionWithModules(transaction, fsModule, cryptoModule, pathModule);
      afterExchange?.();
      // Until the captured target is either committed or atomically restored,
      // the temporary path is a recovery copy and must never be best-effort
      // cleanup.
      const exchangedDirectoryFd = fsModule.openSync(
        directory,
        fsModule.constants.O_RDONLY | fsModule.constants.O_DIRECTORY,
      );
      try {
        fsModule.fsyncSync(exchangedDirectoryFd);
      } finally {
        fsModule.closeSync(exchangedDirectoryFd);
      }

      let captured: ProjectsFileSnapshot;
      try {
        captured = readProjectsFileSnapshotWithModules(
          temporaryPath,
          fsModule,
          cryptoModule,
        );
      } catch (error) {
        preserveTemporary = true;
        throw new Error(
          `[projects-file] exchanged target became unsafe; recovery retained at ${temporaryPath}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!projectsSnapshotEqual(initial, captured)) {
        // The exchange captured a writer that won after our final read. Restore
        // that exact inode atomically; never overwrite or discard its bytes.
        let published: ProjectsFileSnapshot;
        try {
          published = readProjectsFileSnapshotWithModules(
            projectsPath,
            fsModule,
            cryptoModule,
          );
        } catch (error) {
          preserveTemporary = true;
          throw new Error(
            `[projects-file] cannot safely roll back changed target; recovery retained at ${temporaryPath}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
        if (!projectsSnapshotEqual(prepared, published)) {
          preserveTemporary = true;
          fail(`published candidate changed during rollback; recovery retained at ${temporaryPath}`);
        }
        transaction.phase = 'rollback';
        transaction.captured = captured;
        writeProjectsTransactionWithModules(transaction, fsModule, cryptoModule, pathModule);
        exchangeProjectsPathsWithModules(
          temporaryPath,
          projectsPath,
          exchangeHelperPath,
          fsModule,
          pathModule,
          childProcessModule,
        );
        const restored = readProjectsFileSnapshotWithModules(
          projectsPath,
          fsModule,
          cryptoModule,
        );
        const rolledBackCandidate = readProjectsFileSnapshotWithModules(
          temporaryPath,
          fsModule,
          cryptoModule,
        );
        if (
          !projectsSnapshotEqual(captured, restored)
          || !projectsSnapshotEqual(prepared, rolledBackCandidate)
        ) {
          preserveTemporary = true;
          fail(`rollback identity changed; recovery retained at ${temporaryPath}`);
        }
        fsModule.unlinkSync(temporaryPath);
        temporaryExists = false;
        fsyncProjectsDirectoryWithModules(directory, fsModule);
        removeProjectsJournalWithModules(projectsPath, fsModule, pathModule);
        journalActive = false;
        preserveTemporary = false;
        fail(`projects file changed during atomic publish ${projectsPath}`);
      }

      const published = readProjectsFileSnapshotWithModules(
        projectsPath,
        fsModule,
        cryptoModule,
      );
      if (!projectsSnapshotEqual(prepared, published)) {
        preserveTemporary = true;
        fail(`published projects file changed; recovery retained at ${temporaryPath}`);
      }
      transaction.phase = 'verified';
      writeProjectsTransactionWithModules(transaction, fsModule, cryptoModule, pathModule);
      afterVerify?.();
      fsModule.unlinkSync(temporaryPath);
      temporaryExists = false;
      fsyncProjectsDirectoryWithModules(directory, fsModule);
      afterCleanup?.();
      removeProjectsJournalWithModules(projectsPath, fsModule, pathModule);
      journalActive = false;
      preserveTemporary = false;
    } else {
      if (immediatelyBeforePublish.exists) fail(`projects file appeared before publish ${projectsPath}`);
      // link(2) is an atomic no-replace publication. rename(2) would silently
      // overwrite a file created after the absent observation.
      fsModule.linkSync(temporaryPath, projectsPath);
      fsModule.unlinkSync(temporaryPath);
      temporaryExists = false;
    }
    fsyncProjectsDirectoryWithModules(directory, fsModule);
  } catch (error) {
    if (fd !== null) try { fsModule.closeSync(fd); } catch { /* best effort */ }
    if (temporaryExists && !preserveTemporary) {
      try { fsModule.unlinkSync(temporaryPath); } catch { /* best effort */ }
    }
    if ((preserveTemporary || journalActive) && error && typeof error === 'object') {
      Object.assign(error, { projectsFileAmbiguous: true });
    }
    throw error;
  }
  return { projectId: currentProjectId, changed: true };
}

function projectsFileReaderMain(): void {
  const fsModule = require('fs') as typeof fs;
  const cryptoModule = require('crypto') as typeof crypto;
  const pathModule = require('path') as typeof path;
  const childProcessModule = require('child_process') as typeof childProcess;
  try {
    const projectsPath = process.argv[1] || '/etc/projects';
    const exchangeHelperPath = process.env.NODE_ENV === 'test'
      && process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER
      ? process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER
      : ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL;
    recoverProjectsFileTransactionWithModules(
      projectsPath,
      fsModule,
      cryptoModule,
      pathModule,
      childProcessModule,
      exchangeHelperPath,
    );
    process.stdout.write(`${JSON.stringify(
      readProjectsFileSnapshotWithModules(projectsPath, fsModule, cryptoModule),
    )}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.slice(0, 2048)}\n`);
    process.exitCode = (error as { projectsFileAmbiguous?: boolean })?.projectsFileAmbiguous
      ? PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL
      : 1;
  }
}

/**
 * Safe reader shared by every /etc/projects consumer. Recovery and the read
 * execute in one exclusive host-stable flock, so no process can observe the
 * exchange's private intermediate namespace.
 */
export function readProjectsFileSnapshot(
  projectsPath = '/etc/projects',
  lockPath = PHYSICAL_MUTATION_LOCK_PATH,
): ProjectsFileSnapshot {
  ensurePhysicalMutationFence(lockPath);
  const output = childProcess.execFileSync(
    '/usr/bin/flock',
    [
      '--exclusive',
      '--no-fork',
      lockPath,
      process.execPath,
      '-e',
      PROJECTS_FILE_READER_SCRIPT,
      projectsPath,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const parsed = JSON.parse(output) as ProjectsFileSnapshot;
  if (
    !parsed
    || typeof parsed.exists !== 'boolean'
    || typeof parsed.contents !== 'string'
    || !Number.isInteger(parsed.mode)
    || (parsed.exists ? !parsed.identity : parsed.identity !== null)
  ) {
    throw new Error(`[projects-file] malformed reader response for ${projectsPath}`);
  }
  return parsed;
}

/** Proves the installed, pinned helper and the target mount's real syscall capability. */
export function assertAtomicFileExchangeCapability(
  scratchDirectory = '/etc',
  helperPath = ATOMIC_FILE_EXCHANGE_HELPER_PATH,
  lockPath = PHYSICAL_MUTATION_LOCK_PATH,
): void {
  ensurePhysicalMutationFence(lockPath);
  runAtomicFileExchangeHelperWithModules(
    ['--self-test', scratchDirectory],
    helperPath,
    fs,
    path,
    childProcess,
    lockPath,
  );
}

/** Exported for deterministic temp-directory race tests; production uses the fenced helper. */
export function mutateProjectsFile(
  operation: 'ensure' | 'remove',
  expectedText: string,
  durablePath: string,
  projectsPath = '/etc/projects',
  options: ProjectsFileMutationOptions = {},
): ProjectsFileMutationResult {
  return mutateProjectsFileWithModules(
    operation,
    expectedText,
    durablePath,
    projectsPath,
    fs,
    crypto,
    path,
    childProcess,
    options.beforePublish,
    options.beforeExchange,
    options.afterJournal,
    options.afterExchange,
    options.afterVerify,
    options.afterCleanup,
    options.exchangeHelperPath
      ?? (process.env.NODE_ENV === 'test'
        ? process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER
        : undefined)
      ?? ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL,
  );
}

/** Standalone child entry point executed under the process-wide mutation flock. */
function projectsFileHelperMain(): void {
  const fsModule = require('fs') as typeof fs;
  const cryptoModule = require('crypto') as typeof crypto;
  const pathModule = require('path') as typeof path;
  const childProcessModule = require('child_process') as typeof childProcess;
  try {
    const exchangeHelperPath = process.env.NODE_ENV === 'test'
      && process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER
      ? process.env.NYABASE_TEST_ATOMIC_FILE_EXCHANGE_HELPER
      : ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL;
    const result = mutateProjectsFileWithModules(
      process.argv[1] as 'ensure' | 'remove',
      process.argv[2],
      process.argv[3],
      process.argv[4] || '/etc/projects',
      fsModule,
      cryptoModule,
      pathModule,
      childProcessModule,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      exchangeHelperPath,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message.slice(0, 2048)}\n`);
    process.exitCode = (error as { projectsFileAmbiguous?: boolean })?.projectsFileAmbiguous
      ? PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL
      : 1;
  }
}

export const PROJECTS_FILE_HELPER_SCRIPT = [
  `const PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL = ${PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL};`,
  `const ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL = ${JSON.stringify(ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL)};`,
  `const projectsStatIdentity = ${projectsStatIdentity.toString()};`,
  `const projectsIdentityEqual = ${projectsIdentityEqual.toString()};`,
  `const projectsSnapshotEqual = ${projectsSnapshotEqual.toString()};`,
  `const fsyncProjectsDirectoryWithModules = ${fsyncProjectsDirectoryWithModules.toString()};`,
  `const projectsJournalPathWithModules = ${projectsJournalPathWithModules.toString()};`,
  `const validateProjectsTransactionWithModules = ${validateProjectsTransactionWithModules.toString()};`,
  `const writeProjectsTransactionWithModules = ${writeProjectsTransactionWithModules.toString()};`,
  `const removeProjectsJournalWithModules = ${removeProjectsJournalWithModules.toString()};`,
  `const runAtomicFileExchangeHelperWithModules = ${runAtomicFileExchangeHelperWithModules.toString()};`,
  `const exchangeProjectsPathsWithModules = ${exchangeProjectsPathsWithModules.toString()};`,
  `const readProjectsFileSnapshotWithModules = ${readProjectsFileSnapshotWithModules.toString()};`,
  `const recoverProjectsFileTransactionWithModules = ${recoverProjectsFileTransactionWithModules.toString()};`,
  `const mutateProjectsFileWithModules = ${mutateProjectsFileWithModules.toString()};`,
  `(${projectsFileHelperMain.toString()})();`,
].join('\n');

export const PROJECTS_FILE_READER_SCRIPT = [
  `const PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL = ${PROJECTS_FILE_AMBIGUITY_EXIT_CODE_INTERNAL};`,
  `const ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL = ${JSON.stringify(ATOMIC_FILE_EXCHANGE_HELPER_PATH_INTERNAL)};`,
  `const projectsStatIdentity = ${projectsStatIdentity.toString()};`,
  `const projectsIdentityEqual = ${projectsIdentityEqual.toString()};`,
  `const projectsSnapshotEqual = ${projectsSnapshotEqual.toString()};`,
  `const fsyncProjectsDirectoryWithModules = ${fsyncProjectsDirectoryWithModules.toString()};`,
  `const projectsJournalPathWithModules = ${projectsJournalPathWithModules.toString()};`,
  `const validateProjectsTransactionWithModules = ${validateProjectsTransactionWithModules.toString()};`,
  `const removeProjectsJournalWithModules = ${removeProjectsJournalWithModules.toString()};`,
  `const runAtomicFileExchangeHelperWithModules = ${runAtomicFileExchangeHelperWithModules.toString()};`,
  `const exchangeProjectsPathsWithModules = ${exchangeProjectsPathsWithModules.toString()};`,
  `const readProjectsFileSnapshotWithModules = ${readProjectsFileSnapshotWithModules.toString()};`,
  `const recoverProjectsFileTransactionWithModules = ${recoverProjectsFileTransactionWithModules.toString()};`,
  `(${projectsFileReaderMain.toString()})();`,
].join('\n');
