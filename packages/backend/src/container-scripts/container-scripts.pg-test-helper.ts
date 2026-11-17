import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { zCreateContainerScriptRequest, type CreateContainerScriptRequest } from '@nyabase/common';
import { vi } from 'vitest';
import { seedContainer, seedImage, seedPool, seedServer, seedUser } from '../iam/access.pg-test-helper.js';
import { deriveInstanceName, IncusError, type IncusClientPort } from '../incus/index.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { ReconcileWakeService } from '../reconcile/reconcile-wake.service.js';
import { ContainerMaintenanceService } from './container-maintenance.service.js';
import { ContainerScriptReadModel } from './container-script-read-model.js';
import { ContainerScriptScheduler } from './container-script-scheduler.service.js';
import { ContainerScriptTargetsRepository } from './container-script-targets.repository.js';
import { ContainerScriptsRepository } from './container-scripts.repository.js';
import { ContainerScriptsService } from './container-scripts.service.js';

/** What the fake guest does when the wrapper runs: by default exit 0 with "ok". */
export type GuestBehavior = (input: { readonly script: string; readonly instance: string; readonly wrapper: string }) => {
  readonly rc: number | null;
  readonly output?: string;
  readonly timedOut?: boolean;
};

interface GuestFile {
  body: Buffer;
  type: 'file' | 'directory';
  mode?: number;
  uid?: number;
  gid?: number;
}

/**
 * A server's Incus as far as container scripts use it: instances with a
 * status and boot (`last_used_at`), an in-memory guest filesystem per
 * instance, and an exec that, for the wrapper, writes the result files the
 * real wrapper would (as `behavior` decides).
 */
export class FakeGuests {
  readonly instances = new Map<string, { status: 'Running' | 'Stopped'; lastUsedAt: string }>();
  readonly files = new Map<string, Map<string, GuestFile>>();
  readonly executed: Array<{ instance: string; script: string; wrapper: string }> = [];
  behavior: GuestBehavior = () => ({ rc: 0, output: 'ok\n' });
  /** Exec of the wrapper fails with this (the agent dropped) instead of running. */
  execError: Error | null = null;
  private bootCounter = 0;

  boot(instance: string): string {
    this.bootCounter += 1;
    const lastUsedAt = new Date(Date.now() + this.bootCounter).toISOString();
    this.instances.set(instance, { status: 'Running', lastUsedAt });
    return lastUsedAt;
  }

  stop(instance: string): void {
    const current = this.instances.get(instance);
    if (current) this.instances.set(instance, { ...current, status: 'Stopped' });
  }

  guestFiles(instance: string): Map<string, GuestFile> {
    let files = this.files.get(instance);
    if (!files) {
      files = new Map();
      this.files.set(instance, files);
    }
    return files;
  }

  readonly client = {
    listInstances: async () => ({
      metadata: [...this.instances.entries()].map(([name, instance]) => ({
        name,
        status: instance.status,
        last_used_at: instance.lastUsedAt,
      })),
    }),
    getInstance: async (name: string) => {
      const instance = this.instances.get(name);
      if (!instance) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure', { error: 'not found' });
      return { metadata: { name, status: instance.status, last_used_at: instance.lastUsedAt } };
    },
    getFile: async (name: string, path: string) => {
      const file = this.guestFiles(name).get(path);
      if (!file) throw new IncusError('INCUS_NOT_FOUND', 'managed_failure', { error: 'not found' });
      return { status: 200, headers: {}, ...file };
    },
    putFile: async (
      name: string,
      path: string,
      content: Buffer | string,
      options: { type?: 'file' | 'directory'; write?: 'overwrite' | 'append'; mode?: number; uid?: number; gid?: number } = {},
    ) => {
      const files = this.guestFiles(name);
      const body = Buffer.isBuffer(content) ? content : Buffer.from(content);
      const existing = files.get(path);
      files.set(path, {
        body: options.write === 'append' && existing ? Buffer.concat([existing.body, body]) : body,
        type: options.type ?? 'file',
        mode: options.mode,
        uid: options.uid,
        gid: options.gid,
      });
      return { metadata: {} };
    },
    execInstance: async (name: string, document: { command?: string[] }) => {
      const command = document.command ?? [];
      const files = this.guestFiles(name);
      if (command[0] === 'rm') {
        const dir = command[command.length - 1]!;
        for (const path of [...files.keys()]) if (path === dir || path.startsWith(`${dir}/`)) files.delete(path);
        return { envelope: { type: 'async', operation: `/1.0/operations/${randomUUID()}` }, metadata: {} };
      }
      if (this.execError) throw this.execError;
      const wrapperPath = command[1]!;
      const dir = wrapperPath.slice(0, -'/wrapper'.length);
      const script = files.get(`${dir}/script`)?.body.toString('utf8') ?? '';
      const wrapper = files.get(wrapperPath)?.body.toString('utf8') ?? '';
      this.executed.push({ instance: name, script, wrapper });
      const result = this.behavior({ script, instance: name, wrapper });
      files.set(`${dir}/output`, { body: Buffer.from(result.output ?? ''), type: 'file' });
      if (result.timedOut) files.set(`${dir}/timed_out`, { body: Buffer.alloc(0), type: 'file' });
      if (result.rc !== null) files.set(`${dir}/rc`, { body: Buffer.from(`${result.rc}\n`), type: 'file' });
      return { envelope: { type: 'async', operation: `/1.0/operations/${randomUUID()}` }, metadata: {} };
    },
    getOperationWait: async () => ({ metadata: { status: 'Success' }, envelope: {} }),
  };
}

export interface ScriptHarness {
  readonly database: Kysely<NyabaseDatabase>;
  readonly guests: FakeGuests;
  readonly service: ContainerScriptsService;
  readonly scheduler: ContainerScriptScheduler;
  readonly maintenance: ContainerMaintenanceService;
  readonly audit: { append: ReturnType<typeof vi.fn> };
  readonly adminId: string;
  readonly ownerId: string;
  readonly serverId: string;
  readonly poolId: string;
  readonly imageId: string;
  /** A fresh scheduler over the same database and guests (a Backend restart). */
  restart(): Promise<ContainerScriptScheduler>;
  /** Seeds a container and (when running) boots its instance. */
  container(options?: { running?: boolean; ownerId?: string }): Promise<{ id: string; instance: string }>;
  /** One scheduler pass, then waits for every run it started. */
  pass(): Promise<void>;
  stop(): Promise<void>;
}

export async function scriptHarness(
  database: Kysely<NyabaseDatabase>,
  options: { maxConcurrent?: number; maxConcurrentPerServer?: number } = {},
): Promise<ScriptHarness> {
  const guests = new FakeGuests();
  const adminId = await seedUser(database);
  const ownerId = await seedUser(database);
  const serverId = await seedServer(database);
  const poolId = await seedPool(database, serverId);
  const imageId = await seedImage(database);
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const settings: Record<string, number> = {
    'containerScripts.maxConcurrent': options.maxConcurrent ?? 8,
    'containerScripts.maxConcurrentPerServer': options.maxConcurrentPerServer ?? 8,
  };
  const scriptsRepository = new ContainerScriptsRepository(database);
  const targets = new ContainerScriptTargetsRepository(database);
  const read = new ContainerScriptReadModel(database);
  const transactions = new PgTransactionManager(database);
  const makeScheduler = () => {
    const scheduler = new ContainerScriptScheduler(
      scriptsRepository,
      targets,
      read,
      transactions,
      audit as never,
      { get: (key: string) => settings[key] } as never,
      {
        get: async () => guests.client as unknown as IncusClientPort,
        listServerIds: async () => [serverId],
      },
      { isConnected: () => true } as never,
      new ReconcileWakeService(),
    );
    scheduler.onApplicationBootstrap();
    return scheduler;
  };
  let scheduler = makeScheduler();
  const service = new ContainerScriptsService(scriptsRepository, targets, read, transactions, audit as never, {
    wake: () => undefined,
  } as never);
  const harness: ScriptHarness = {
    database,
    guests,
    service,
    get scheduler() {
      return scheduler;
    },
    maintenance: new ContainerMaintenanceService(read),
    audit,
    adminId,
    ownerId,
    serverId,
    poolId,
    imageId,
    async restart() {
      await scheduler.onModuleDestroy();
      scheduler = makeScheduler();
      return scheduler;
    },
    async container(containerOptions = {}) {
      const running = containerOptions.running ?? true;
      const id = await seedContainer(database, {
        ownerId: containerOptions.ownerId ?? ownerId,
        serverId,
        poolId,
        imageId,
        running,
      });
      const instance = deriveInstanceName(id);
      guests.boot(instance);
      if (!running) guests.stop(instance);
      return { id, instance };
    },
    async pass() {
      // Every server, every pass: tests change instances between passes.
      (scheduler as unknown as { lastFullObserve: number }).lastFullObserve = 0;
      await scheduler.process();
      await scheduler.settle();
    },
    async stop() {
      await scheduler.onModuleDestroy();
    },
  };
  return harness;
}

export function createRequest(input: Partial<CreateContainerScriptRequest> & Record<string, unknown> = {}): CreateContainerScriptRequest {
  return zCreateContainerScriptRequest.parse({
    name: `script-${randomUUID().slice(0, 8)}`,
    script: '#!/bin/sh\necho hello\n',
    scope: { all: true },
    ...input,
  });
}
