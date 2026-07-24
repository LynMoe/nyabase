import { BadRequestException, Injectable, OnModuleInit } from '@nestjs/common';
import { dirname, resolve } from 'path';
import {
  mkdir,
  open,
  readFile,
  rm,
  stat,
} from 'fs/promises';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { stringify as stringifyYaml } from 'yaml';
import {
  controlPlaneConfigDefinitions,
  getControlPlaneConfigDefinition,
  type ConfigSourceName,
  type ControlPlaneConfigKey,
  type PublicSettingsDto,
  type SystemSettingFieldDto,
} from '@nyabase/common';
import {
  configFilePath,
  loadNyabaseConfig,
  readConfigFileIdentity,
  type ConfigFileIdentity,
  type LoadedNyabaseConfig,
  type ResolvedConfigField,
} from './nyabase-config-loader.js';

const HIDDEN_SECRET = '********';
const RESERVED_CONTROL_PLANE_NAMESPACE = '__nyabase';
const RESERVED_CONTROL_PLANE_REVISION_PATH = '__nyabase.revision';
const DURABLE_CONFIG_STATE_VERSION = 1;
const CONFIG_EXCHANGE_JOURNAL_VERSION = 1;
const WRITER_LEASE_STALE_MS = 60_000;
const WRITER_LEASE_WAIT_MS = 10_000;

interface DurableConfigState {
  schemaVersion: typeof DURABLE_CONFIG_STATE_VERSION;
  revision: number;
  configFileIdentity: ConfigFileIdentity;
}

interface WriterLeaseRecord {
  token: string;
  pid: number;
  createdAt: number;
}

type ConfigExchangePhase = 'prepared' | 'exchanged' | 'verified' | 'rollback' | 'postcleanup';

interface ConfigExchangeJournal {
  schemaVersion: typeof CONFIG_EXCHANGE_JOURNAL_VERSION;
  configPath: string;
  statePath: string;
  entryPath: string;
  expectedIdentity: ConfigFileIdentity;
  candidateIdentity: ConfigFileIdentity;
  externalIdentity: ConfigFileIdentity | null;
  intendedRevision: number;
  phase: ConfigExchangePhase;
}

export type ConfigExchangeCrashPhase =
  | 'journal-prepared'
  | 'exchange-complete'
  | 'exchange-journaled'
  | 'captured-verified'
  | 'rollback-complete'
  | 'state-committed'
  | 'postcleanup';

class SimulatedConfigProcessCrashError extends Error {
  constructor(readonly phase: ConfigExchangeCrashPhase) {
    super(`Simulated system settings process crash after ${phase}`);
    this.name = 'SimulatedConfigProcessCrashError';
  }
}

export class SystemSettingsRevisionConflictError extends Error {
  constructor(
    readonly currentRevision: number,
    readonly currentSnapshotToken: string,
  ) {
    super(`System settings changed; current revision is ${currentRevision}`);
    this.name = 'SystemSettingsRevisionConflictError';
  }
}

export class ConfigFileChangedBeforePublishError extends Error {
  constructor() {
    super('Config file changed before atomic publish');
    this.name = 'ConfigFileChangedBeforePublishError';
  }
}

@Injectable()
export class NyabaseConfigService implements OnModuleInit {
  private readonly snapshotTokenKey = randomBytes(32);
  private snapshot: LoadedNyabaseConfig;
  private snapshotTokenValue: string;
  /** Serializes admitted online edits so concurrent patches cannot lose fields. */
  private editableUpdateTail: Promise<void> = Promise.resolve();

  constructor() {
    recoverConfigExchange(configFilePath());
    this.snapshot = loadDurableNyabaseConfig();
    this.snapshotTokenValue = this.computeSnapshotToken(this.snapshot);
  }

  onModuleInit(): void {
    this.validateProductionSecrets();
  }

  reload(): LoadedNyabaseConfig {
    recoverConfigExchange(configFilePath());
    this.snapshot = loadDurableNyabaseConfig();
    this.snapshotTokenValue = this.computeSnapshotToken(this.snapshot);
    this.validateProductionSecrets();
    return this.snapshot;
  }

  configFile(): string {
    return this.snapshot.configFile;
  }

  revision(): number {
    return this.snapshot.revision;
  }

  snapshotToken(): string {
    return this.snapshotTokenValue;
  }

  field<T = unknown>(key: ControlPlaneConfigKey): ResolvedConfigField<T> {
    return this.snapshot.fields[key] as ResolvedConfigField<T>;
  }

  get<T = unknown>(key: ControlPlaneConfigKey): T {
    return this.field<T>(key).effectiveValue;
  }

  source(key: ControlPlaneConfigKey): ConfigSourceName {
    return this.field(key).source;
  }

  allFields(): SystemSettingFieldDto[] {
    return controlPlaneConfigDefinitions.map((definition) => {
      const resolved = this.snapshot.fields[definition.key];
      return {
        key: definition.key,
        yamlPath: definition.yamlPath,
        env: definition.env,
        valueKind: definition.valueKind,
        effectiveValue: maskIfSecret(definition.secret, resolved.effectiveValue),
        source: resolved.source,
        yamlValue: maskIfSecret(definition.secret, resolved.yamlValue),
        envValuePresent: resolved.envValuePresent,
        defaultValue: maskIfSecret(definition.secret, resolved.defaultValue),
        secret: definition.secret,
        editable: definition.editable && !definition.restartRequired,
        restartRequired: definition.restartRequired,
        public: definition.public,
        label: definition.label,
        description: definition.description,
      };
    });
  }

  publicSettings(): PublicSettingsDto {
    return {
      branding: {
        title: this.get<string>('branding.title'),
        description: this.get<string>('branding.description'),
      },
    };
  }

  updateEditable(
    values: Record<string, unknown>,
    expectedRevision: number,
    expectedSnapshotToken: string,
  ): Promise<void> {
    const admittedValues = { ...values };
    const completion = this.editableUpdateTail.then(() => new Promise<void>((resolve, reject) => {
      // The caller admits this queue entry synchronously while holding its
      // current-authority transaction. Defer validation/YAML/filesystem work
      // to the next event-loop turn so none of it retains the SQLite lease.
      setImmediate(() => {
        void this.applyEditableUpdate(
          admittedValues,
          expectedRevision,
          expectedSnapshotToken,
        ).then(resolve, reject);
      });
    }));
    // A rejected edit must not poison later, independently admitted edits.
    this.editableUpdateTail = completion.catch(() => undefined);
    return completion;
  }

  private async applyEditableUpdate(
    values: Record<string, unknown>,
    expectedRevision: number,
    expectedSnapshotToken: string,
  ): Promise<void> {
    await withNyabaseConfigWriterLease(this.snapshot.configFile, async () => {
      if (Object.keys(values).length === 0) {
        throw new BadRequestException('At least one setting is required');
      }
      // Every supported YAML writer holds the same cross-process lease. The
      // identity comparison below detects pre-lease or protocol-violating edits;
      // the lease, rather than a check-then-rename sequence, is the publication
      // CAS boundary.
      const current = this.reload();
      if (
        current.revision !== expectedRevision
        || this.snapshotTokenValue !== expectedSnapshotToken
      ) {
        throw new SystemSettingsRevisionConflictError(
          current.revision,
          this.snapshotTokenValue,
        );
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new BadRequestException('System settings revision is exhausted');
      }
      const nextYaml = cloneObject(current.rawYaml);

      for (const [key, rawValue] of Object.entries(values)) {
        const definition = getControlPlaneConfigDefinition(key);
        if (!definition) throw new BadRequestException(`Unknown config key: ${key}`);
        if (!definition.editable || definition.secret) {
          throw new BadRequestException(`Config key is not editable: ${key}`);
        }
        if (definition.restartRequired) {
          throw new BadRequestException(`Config key requires restart and cannot be edited online: ${key}`);
        }
        if (
          definition.yamlPath === RESERVED_CONTROL_PLANE_NAMESPACE
          || definition.yamlPath.startsWith(`${RESERVED_CONTROL_PLANE_NAMESPACE}.`)
        ) {
          throw new Error(`Editable config key targets reserved namespace: ${key}`);
        }
        if (definition.env && process.env[definition.env] !== undefined && process.env[definition.env] !== '') {
          throw new BadRequestException(`Config key is overridden by environment: ${key}`);
        }
        const parsed = definition.schema.safeParse(rawValue);
        if (!parsed.success) {
          throw new BadRequestException(`Invalid config value for ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        }
        setByPath(nextYaml, definition.yamlPath, parsed.data);
      }

      const nextRevision = current.revision + 1;
      // The embedded number is diagnostic/backward-compatible only. The
      // adjacent backend-owned state file is the monotonic authority.
      setByPath(nextYaml, RESERVED_CONTROL_PLANE_REVISION_PATH, nextRevision);

      try {
        await writeYamlAtomicIfUnchanged(
          current.configFile,
          nextYaml,
          current.configFileIdentity,
          { intendedRevision: nextRevision },
        );
      } catch (error) {
        if (error instanceof ConfigFileChangedBeforePublishError) {
          const latest = this.reload();
          throw new SystemSettingsRevisionConflictError(
            latest.revision,
            this.snapshotTokenValue,
          );
        }
        throw error;
      }
      const loaded = loadNyabaseConfig();
      writeDurableConfigState(current.configFile, {
        schemaVersion: DURABLE_CONFIG_STATE_VERSION,
        revision: nextRevision,
        configFileIdentity: loaded.configFileIdentity,
      });
      this.snapshot = { ...loaded, revision: nextRevision };
      this.snapshotTokenValue = this.computeSnapshotToken(this.snapshot);
      this.validateProductionSecrets();
    });
  }

  private computeSnapshotToken(snapshot: LoadedNyabaseConfig): string {
    const resolvedFields = Object.fromEntries(controlPlaneConfigDefinitions.map((definition) => {
      const field = snapshot.fields[definition.key];
      return [definition.key, {
        effectiveValue: field.effectiveValue,
        source: field.source,
        yamlValue: field.yamlValue,
        envValuePresent: field.envValuePresent,
      }];
    }));
    return createHmac('sha256', this.snapshotTokenKey)
      // Include the exact file-byte identity as well as parsed/effective
      // values. Otherwise an external comment-, ordering-, or formatting-only
      // edit would retain the same token and could be silently replaced by the
      // next UI write even though it changed the durable file after the UI's
      // baseline was read.
      .update(JSON.stringify(canonicalize({
        configFileIdentity: snapshot.configFileIdentity,
        rawYaml: snapshot.rawYaml,
        resolvedFields,
      })))
      .digest('hex');
  }

  validateProductionSecrets(): void {
    if (
      this.get<string>('runtime.nodeEnv') === 'production'
      && this.get<string>('auth.jwtSecret') === 'change-me-in-production'
    ) {
      throw new Error('auth.jwtSecret must be set to a strong secret in production');
    }
  }
}

function maskIfSecret(secret: boolean, value: unknown): unknown {
  if (!secret) return value;
  if (value === undefined || value === null || value === '') return value;
  return HIDDEN_SECRET;
}

function cloneObject(input: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}

function setByPath(input: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split('.');
  let cursor = input;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
}

export async function writeYamlAtomicIfUnchanged(
  path: string,
  value: Record<string, unknown>,
  expectedIdentity: ConfigFileIdentity,
  hooks?: {
    beforePublishFence?: () => void | Promise<void>;
    /** Deterministic seam after the final compare and before namespace publish. */
    afterCompareBeforePublish?: () => void | Promise<void>;
    /** Durable crash seams used by restart-recovery regressions. */
    simulateCrashAfter?: ConfigExchangeCrashPhase;
    /** Revision that the candidate config and sidecar will own after commit. */
    intendedRevision?: number;
  },
): Promise<void> {
  recoverConfigExchange(path);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o755 });
  const tmpPath = configExchangeEntryPath(path);
  const intendedRevision = hooks?.intendedRevision ?? embeddedConfigRevision(value)
    ?? Math.min(Number.MAX_SAFE_INTEGER, (readDurableConfigState(path)?.revision ?? 0) + 1);
  const content = stringifyYaml(value, { sortMapEntries: false });
  let temporaryExists = false;
  let journalWritten = false;
  try {
    const candidateHandle = await open(tmpPath, 'wx', 0o600);
    temporaryExists = true;
    try {
      await candidateHandle.writeFile(content, 'utf8');
      await candidateHandle.sync();
    } finally {
      await candidateHandle.close();
    }
    const candidateIdentity = readConfigFileIdentity(tmpPath);
    let journal: ConfigExchangeJournal = {
      schemaVersion: CONFIG_EXCHANGE_JOURNAL_VERSION,
      configPath: resolve(path),
      statePath: resolve(durableConfigStatePath(path)),
      entryPath: resolve(tmpPath),
      expectedIdentity,
      candidateIdentity,
      externalIdentity: null,
      intendedRevision,
      phase: 'prepared',
    };
    journalWritten = true;
    writeConfigExchangeJournal(path, journal);
    simulateConfigCrash(hooks, 'journal-prepared');
    await hooks?.beforePublishFence?.();
    const currentIdentity = readConfigFileIdentity(path);
    if (!sameConfigFileIdentity(currentIdentity, expectedIdentity)) {
      cleanupPreparedConfigExchange(path, tmpPath, {
        ...journal,
        externalIdentity: currentIdentity,
        phase: 'rollback',
      });
      temporaryExists = false;
      journalWritten = false;
      throw new ConfigFileChangedBeforePublishError();
    }
    await hooks?.afterCompareBeforePublish?.();

    if (!expectedIdentity.exists) {
      // link(2) publishes only while the destination is still absent. A plain
      // rename could overwrite a file created after the final comparison.
      try {
        linkSync(tmpPath, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          cleanupPreparedConfigExchange(path, tmpPath, {
            ...journal,
            externalIdentity: readConfigFileIdentity(path),
            phase: 'rollback',
          });
          temporaryExists = false;
          journalWritten = false;
          throw new ConfigFileChangedBeforePublishError();
        }
        throw error;
      }
      fsyncDirectory(dir);
      simulateConfigCrash(hooks, 'exchange-complete');
      journal = { ...journal, externalIdentity: expectedIdentity, phase: 'verified' };
      writeConfigExchangeJournal(path, journal);
      simulateConfigCrash(hooks, 'captured-verified');
      commitConfigExchangeState(journal);
      simulateConfigCrash(hooks, 'state-committed');
      journal = { ...journal, phase: 'postcleanup' };
      writeConfigExchangeJournal(path, journal);
      unlinkSync(tmpPath);
      temporaryExists = false;
      fsyncDirectory(dir);
      simulateConfigCrash(hooks, 'postcleanup');
      removeConfigExchangeJournal(path);
      journalWritten = false;
      return;
    }

    // renameat2(RENAME_EXCHANGE) atomically captures the exact namespace entry
    // being replaced at tmpPath. If an external writer won the tiny gap after
    // our final compare, its inode is captured and then atomically restored.
    exchangePaths(tmpPath, path);
    fsyncDirectory(dir);
    simulateConfigCrash(hooks, 'exchange-complete');
    const capturedIdentity = readConfigFileIdentity(tmpPath);
    journal = { ...journal, externalIdentity: capturedIdentity, phase: 'exchanged' };
    writeConfigExchangeJournal(path, journal);
    simulateConfigCrash(hooks, 'exchange-journaled');
    if (!sameConfigFileIdentity(capturedIdentity, expectedIdentity)) {
      const publishedIdentity = readConfigFileIdentity(path);
      if (!sameConfigFileIdentity(publishedIdentity, candidateIdentity)) {
        throw new Error(`System settings publish is ambiguous; recovery retained at ${tmpPath}`);
      }
      journal = { ...journal, phase: 'rollback' };
      writeConfigExchangeJournal(path, journal);
      exchangePaths(tmpPath, path);
      fsyncDirectory(dir);
      simulateConfigCrash(hooks, 'rollback-complete');
      const restoredIdentity = readConfigFileIdentity(path);
      const rolledBackCandidate = readConfigFileIdentity(tmpPath);
      if (
        !sameConfigFileIdentity(restoredIdentity, capturedIdentity)
        || !sameConfigFileIdentity(rolledBackCandidate, candidateIdentity)
      ) {
        throw new Error(`System settings rollback is ambiguous; recovery retained at ${tmpPath}`);
      }
      unlinkSync(tmpPath);
      temporaryExists = false;
      fsyncDirectory(dir);
      removeConfigExchangeJournal(path);
      journalWritten = false;
      throw new ConfigFileChangedBeforePublishError();
    }
    journal = { ...journal, phase: 'verified' };
    writeConfigExchangeJournal(path, journal);
    simulateConfigCrash(hooks, 'captured-verified');
    const publishedIdentity = readConfigFileIdentity(path);
    if (!sameConfigFileIdentity(publishedIdentity, candidateIdentity)) {
      throw new Error(`System settings publish changed unexpectedly; recovery retained at ${tmpPath}`);
    }
    commitConfigExchangeState(journal);
    simulateConfigCrash(hooks, 'state-committed');
    journal = { ...journal, phase: 'postcleanup' };
    writeConfigExchangeJournal(path, journal);
    unlinkSync(tmpPath);
    temporaryExists = false;
    fsyncDirectory(dir);
    simulateConfigCrash(hooks, 'postcleanup');
    removeConfigExchangeJournal(path);
    journalWritten = false;
  } catch (error) {
    if (error instanceof SimulatedConfigProcessCrashError) throw error;
    if (temporaryExists && !journalWritten) {
      await rm(tmpPath, { force: true }).catch(() => undefined);
    }
    if (journalWritten) {
      throw new Error(
        `System settings exchange is ambiguous; durable recovery retained at ${configExchangeJournalPath(path)} and ${tmpPath}`,
        { cause: error },
      );
    }
    throw error;
  }
}

function configExchangeJournalPath(configFile: string): string {
  return `${configFile}.nyabase-exchange.json`;
}

function configExchangeJournalNextPath(configFile: string): string {
  return `${configExchangeJournalPath(configFile)}.next`;
}

function configExchangeEntryPath(configFile: string): string {
  return `${configFile}.nyabase-exchange-entry`;
}

function embeddedConfigRevision(value: Record<string, unknown>): number | null {
  const namespace = value[RESERVED_CONTROL_PLANE_NAMESPACE];
  if (!namespace || typeof namespace !== 'object' || Array.isArray(namespace)) return null;
  const revision = (namespace as Record<string, unknown>).revision;
  return Number.isSafeInteger(revision) && (revision as number) >= 1
    ? revision as number
    : null;
}

function simulateConfigCrash(
  hooks: { simulateCrashAfter?: ConfigExchangeCrashPhase } | undefined,
  phase: ConfigExchangeCrashPhase,
): void {
  if (hooks?.simulateCrashAfter === phase) throw new SimulatedConfigProcessCrashError(phase);
}

function writeConfigExchangeJournal(configFile: string, journal: ConfigExchangeJournal): void {
  const path = configExchangeJournalPath(configFile);
  const nextPath = configExchangeJournalNextPath(configFile);
  let fd: number | null = null;
  try {
    fd = openSync(nextPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(journal)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(nextPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
    throw error;
  }
}

function removeConfigExchangeJournal(configFile: string): void {
  unlinkSync(configExchangeJournalPath(configFile));
  fsyncDirectory(dirname(configFile));
}

function cleanupPreparedConfigExchange(
  configFile: string,
  entryPath: string,
  cleanupJournal: ConfigExchangeJournal,
): void {
  writeConfigExchangeJournal(configFile, cleanupJournal);
  unlinkSync(entryPath);
  fsyncDirectory(dirname(configFile));
  removeConfigExchangeJournal(configFile);
}

function commitConfigExchangeState(journal: ConfigExchangeJournal): void {
  const currentIdentity = readConfigFileIdentity(journal.configPath);
  if (!sameConfigFileIdentity(currentIdentity, journal.candidateIdentity)) {
    throw new Error('System settings candidate changed before durable state commit');
  }
  writeDurableConfigState(journal.configPath, {
    schemaVersion: DURABLE_CONFIG_STATE_VERSION,
    revision: journal.intendedRevision,
    configFileIdentity: journal.candidateIdentity,
  });
}

/**
 * Resolve a previously fsynced exchange transaction before any service read.
 * Recovery trusts only identities bound by the journal; unknown combinations
 * retain all entries and stop startup rather than choosing a winner.
 */
export function recoverConfigExchange(configFile: string): void {
  const journalPath = configExchangeJournalPath(configFile);
  const nextPath = configExchangeJournalNextPath(configFile);
  let journal = readConfigExchangeJournal(journalPath, configFile);
  const next = readConfigExchangeJournal(nextPath, configFile);
  if (next) {
    if (journal && !sameConfigExchangeOperation(journal, next)) {
      throw configExchangeRecoveryError(configFile, 'journal staging belongs to another operation');
    }
    if (!journal) {
      renameSync(nextPath, journalPath);
      fsyncDirectory(dirname(configFile));
      journal = next;
    } else {
      unlinkSync(nextPath);
      fsyncDirectory(dirname(configFile));
    }
  }

  const entryPath = configExchangeEntryPath(configFile);
  if (!journal) {
    if (readConfigFileIdentity(entryPath).exists) {
      throw configExchangeRecoveryError(configFile, 'unowned fixed recovery entry');
    }
    return;
  }

  const configIdentity = readConfigFileIdentity(configFile);
  const entryIdentity = readConfigFileIdentity(entryPath);
  const state = readDurableConfigState(configFile);
  const stateCommitted = Boolean(state
    && state.revision === journal.intendedRevision
    && sameConfigFileIdentity(state.configFileIdentity, journal.candidateIdentity));

  // A committed/post-cleanup candidate is authoritative. Finish idempotently.
  if (sameConfigFileIdentity(configIdentity, journal.candidateIdentity)
    && (!journal.expectedIdentity.exists || sameConfigFileIdentity(entryIdentity, journal.expectedIdentity))) {
    commitConfigExchangeState(journal);
    if (entryIdentity.exists) unlinkSync(entryPath);
    fsyncDirectory(dirname(configFile));
    removeConfigExchangeJournal(configFile);
    return;
  }
  if (sameConfigFileIdentity(configIdentity, journal.candidateIdentity)
    && !entryIdentity.exists && (journal.phase === 'postcleanup' || stateCommitted)) {
    commitConfigExchangeState(journal);
    removeConfigExchangeJournal(configFile);
    return;
  }

  // The candidate is still in its prepared entry. Either no exchange happened,
  // an external writer won before it, or a journaled rollback completed.
  if (sameConfigFileIdentity(entryIdentity, journal.candidateIdentity)) {
    if (sameConfigFileIdentity(configIdentity, journal.expectedIdentity)) {
      cleanupPreparedConfigExchange(configFile, entryPath, {
        ...journal,
        externalIdentity: configIdentity,
        phase: 'rollback',
      });
      return;
    }
    if (journal.phase === 'prepared'
      || (journal.phase === 'rollback' && journal.externalIdentity
        && sameConfigFileIdentity(configIdentity, journal.externalIdentity))) {
      cleanupPreparedConfigExchange(configFile, entryPath, {
        ...journal,
        externalIdentity: configIdentity,
        phase: 'rollback',
      });
      return;
    }
  }

  if (!entryIdentity.exists
    && journal.phase === 'rollback'
    && journal.externalIdentity
    && sameConfigFileIdentity(configIdentity, journal.externalIdentity)) {
    removeConfigExchangeJournal(configFile);
    return;
  }

  // Exchange completed with a post-compare external winner captured at the
  // fixed entry. Restore it before the loader can canonize the candidate.
  if (sameConfigFileIdentity(configIdentity, journal.candidateIdentity)
    && entryIdentity.exists
    && !sameConfigFileIdentity(entryIdentity, journal.expectedIdentity)
    && !sameConfigFileIdentity(entryIdentity, journal.candidateIdentity)
    && (!journal.externalIdentity || sameConfigFileIdentity(entryIdentity, journal.externalIdentity))) {
    const rollbackJournal: ConfigExchangeJournal = {
      ...journal,
      externalIdentity: entryIdentity,
      phase: 'rollback',
    };
    writeConfigExchangeJournal(configFile, rollbackJournal);
    exchangePaths(entryPath, configFile);
    fsyncDirectory(dirname(configFile));
    if (!sameConfigFileIdentity(readConfigFileIdentity(configFile), entryIdentity)
      || !sameConfigFileIdentity(readConfigFileIdentity(entryPath), journal.candidateIdentity)) {
      throw configExchangeRecoveryError(configFile, 'external-winner rollback postcondition failed');
    }
    unlinkSync(entryPath);
    fsyncDirectory(dirname(configFile));
    removeConfigExchangeJournal(configFile);
    return;
  }

  throw configExchangeRecoveryError(
    configFile,
    `third-state identity (phase=${journal.phase}, config=${identityLabel(configIdentity)}, entry=${identityLabel(entryIdentity)})`,
  );
}

function readConfigExchangeJournal(path: string, configFile: string): ConfigExchangeJournal | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw configExchangeRecoveryError(configFile, `invalid journal JSON at ${path}`);
  }
  if (!isConfigExchangeJournal(value, configFile)) {
    throw configExchangeRecoveryError(configFile, `invalid journal contract at ${path}`);
  }
  return value;
}

function isConfigExchangeJournal(value: unknown, configFile: string): value is ConfigExchangeJournal {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<ConfigExchangeJournal>;
  return candidate.schemaVersion === CONFIG_EXCHANGE_JOURNAL_VERSION
    && candidate.configPath === resolve(configFile)
    && candidate.statePath === resolve(durableConfigStatePath(configFile))
    && candidate.entryPath === resolve(configExchangeEntryPath(configFile))
    && isConfigFileIdentity(candidate.expectedIdentity)
    && isConfigFileIdentity(candidate.candidateIdentity)
    && (candidate.externalIdentity === null || isConfigFileIdentity(candidate.externalIdentity))
    && Number.isSafeInteger(candidate.intendedRevision)
    && (candidate.intendedRevision ?? 0) >= 1
    && ['prepared', 'exchanged', 'verified', 'rollback', 'postcleanup'].includes(candidate.phase ?? '');
}

function isConfigFileIdentity(value: unknown): value is ConfigFileIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<ConfigFileIdentity>;
  return typeof identity.exists === 'boolean'
    && (identity.exists
      ? typeof identity.sha256 === 'string' && /^[0-9a-f]{64}$/.test(identity.sha256)
      : identity.sha256 === null);
}

function sameConfigExchangeOperation(left: ConfigExchangeJournal, right: ConfigExchangeJournal): boolean {
  return left.configPath === right.configPath
    && left.statePath === right.statePath
    && left.entryPath === right.entryPath
    && left.intendedRevision === right.intendedRevision
    && sameConfigFileIdentity(left.expectedIdentity, right.expectedIdentity)
    && sameConfigFileIdentity(left.candidateIdentity, right.candidateIdentity);
}

function configExchangeRecoveryError(configFile: string, detail: string): Error {
  return new Error(
    `System settings recovery is ambiguous; fail-stop with ${configExchangeJournalPath(configFile)} and ${configExchangeEntryPath(configFile)} retained: ${detail}`,
  );
}

function identityLabel(identity: ConfigFileIdentity): string {
  return identity.exists ? identity.sha256 ?? 'invalid' : 'missing';
}

function exchangePaths(left: string, right: string): void {
  if (dirname(left) !== dirname(right)) {
    throw new Error('System settings atomic exchange requires one directory');
  }
  const helper = process.env.NYABASE_ATOMIC_FILE_EXCHANGE_HELPER?.trim()
    || '/usr/local/libexec/nyabase-atomic-file-exchange';
  const helperFd = openSync(
    helper,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  try {
    const stat = fstatSync(helperFd);
    if (
      !stat.isFile()
      || stat.uid !== 0
      || stat.gid !== 0
      || stat.nlink !== 1
      || (stat.mode & 0o022) !== 0
      || (stat.mode & 0o111) === 0
    ) {
      throw new Error('Unsafe system settings atomic-exchange helper provenance');
    }
    execFileSync(
      '/proc/self/fd/3',
      [resolve(left), resolve(right)],
      {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        stdio: ['ignore', 'pipe', 'pipe', helperFd],
      },
    );
  } finally {
    closeSync(helperFd);
  }
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Cross-process writer protocol for the externally editable YAML file.
 *
 * Supported writers use this lease to avoid needless conflicts. Safety does
 * not depend on cooperation: publication uses atomic no-replace/exchange and
 * verifies the namespace entry captured by the exchange.
 */
export async function withNyabaseConfigWriterLease<T>(
  configFile: string,
  work: () => Promise<T>,
): Promise<T> {
  const lockPath = `${configFile}.nyabase-writer.lock`;
  const token = randomBytes(16).toString('hex');
  const startedAt = Date.now();
  await mkdir(dirname(configFile), { recursive: true, mode: 0o755 });
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      const record: WriterLeaseRecord = { token, pid: process.pid, createdAt: Date.now() };
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8');
        await handle.sync();
      } catch (error) {
        await rm(lockPath, { force: true });
        throw error;
      } finally {
        await handle.close();
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await writerLeaseIsStale(lockPath)) {
        await rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() - startedAt >= WRITER_LEASE_WAIT_MS) {
        throw new BadRequestException('System settings writer is busy; retry shortly');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try {
    return await work();
  } finally {
    try {
      const current = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<WriterLeaseRecord>;
      if (current.token === token) await rm(lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function durableConfigStatePath(configFile: string): string {
  return `${configFile}.nyabase-state.json`;
}

function loadDurableNyabaseConfig(): LoadedNyabaseConfig {
  const loaded = loadNyabaseConfig();
  const state = readDurableConfigState(loaded.configFile);
  if (!state) {
    const revision = Math.max(1, loaded.revision);
    writeDurableConfigState(loaded.configFile, {
      schemaVersion: DURABLE_CONFIG_STATE_VERSION,
      revision,
      configFileIdentity: loaded.configFileIdentity,
    });
    return { ...loaded, revision };
  }
  if (sameConfigFileIdentity(state.configFileIdentity, loaded.configFileIdentity)) {
    return { ...loaded, revision: state.revision };
  }
  if (state.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error('System settings revision is exhausted');
  }
  // A changed base file is a new durable snapshot even when an external editor
  // removed or lowered the embedded metadata. Never let that metadata move the
  // backend-owned monotonic revision backward.
  const revision = Math.max(state.revision + 1, loaded.revision);
  writeDurableConfigState(loaded.configFile, {
    schemaVersion: DURABLE_CONFIG_STATE_VERSION,
    revision,
    configFileIdentity: loaded.configFileIdentity,
  });
  return { ...loaded, revision };
}

function readDurableConfigState(configFile: string): DurableConfigState | null {
  const path = durableConfigStatePath(configFile);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid durable system-settings state in ${path}`);
  }
  if (!isDurableConfigState(value)) {
    throw new Error(`Invalid durable system-settings state in ${path}`);
  }
  return value;
}

function writeDurableConfigState(configFile: string, state: DurableConfigState): void {
  const path = durableConfigStatePath(configFile);
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  const tmpPath = `${path}.next`;
  let fd: number | null = null;
  try {
    // A prior process may have died before the atomic rename. The authoritative
    // state path remains intact; this fixed, discoverable staging path is safe
    // to replace before recomputing the next exact identity binding.
    rmSync(tmpPath, { force: true });
    fd = openSync(tmpPath, 'wx', 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, path);
    fsyncDirectory(dirname(path));
  } catch (error) {
    if (fd !== null) try { closeSync(fd); } catch { /* best effort */ }
    rmSync(tmpPath, { force: true });
    throw error;
  }
}

function isDurableConfigState(value: unknown): value is DurableConfigState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<DurableConfigState>;
  return candidate.schemaVersion === DURABLE_CONFIG_STATE_VERSION
    && Number.isSafeInteger(candidate.revision)
    && (candidate.revision ?? 0) >= 1
    && Boolean(candidate.configFileIdentity)
    && typeof candidate.configFileIdentity?.exists === 'boolean'
    && (candidate.configFileIdentity.sha256 === null
      || (typeof candidate.configFileIdentity.sha256 === 'string'
        && /^[0-9a-f]{64}$/.test(candidate.configFileIdentity.sha256)));
}

function sameConfigFileIdentity(left: ConfigFileIdentity, right: ConfigFileIdentity): boolean {
  return left.exists === right.exists && left.sha256 === right.sha256;
}

async function writerLeaseIsStale(lockPath: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(lockPath, 'utf8')) as Partial<WriterLeaseRecord>;
    if (typeof value.createdAt !== 'number' || !Number.isFinite(value.createdAt)) return true;
    if (Date.now() - value.createdAt <= WRITER_LEASE_STALE_MS) return false;
    if (typeof value.pid !== 'number' || !Number.isInteger(value.pid)) return true;
    try {
      process.kill(value.pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if (error instanceof SyntaxError) {
      try {
        const lockStat = await stat(lockPath);
        return Date.now() - lockStat.mtimeMs > WRITER_LEASE_STALE_MS;
      } catch (statError) {
        return (statError as NodeJS.ErrnoException).code === 'ENOENT';
      }
    }
    return false;
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => [key, canonicalize(nested)]));
}
