import { randomUUID } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import {
  AuditAction,
  containerScriptScopeMatches,
  FailureCode,
  type ContainerScriptScope,
  zContainerScriptScope,
  zPublishContainerScriptRequest,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import { seedContainer, seedPool, seedServer, seedUser } from '../iam/access.pg-test-helper.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { IncusError } from '../incus/index.js';
import { scopeMatchSql } from './container-script-scope.js';
import { createRequest, scriptHarness, type ScriptHarness } from './container-scripts.pg-test-helper.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

async function withHarness(work: (harness: ScriptHarness) => Promise<void>, options?: Parameters<typeof scriptHarness>[1]) {
  await withPostgresTestDatabase(async ({ database }) => {
    const harness = await scriptHarness(database, options);
    try {
      await work(harness);
    } finally {
      await harness.stop();
    }
  });
}

async function targetStates(harness: ScriptHarness, scriptId: string): Promise<Record<string, string>> {
  const targets = await harness.service.listTargets(scriptId, {});
  return Object.fromEntries(targets.map((target) => [target.containerId, target.state]));
}

function publish(input: Record<string, unknown>) {
  return zPublishContainerScriptRequest.parse({ script: '#!/bin/sh\necho v2\n', scope: { all: true }, ...input });
}

describePg('container scripts', () => {
  it('runs applyNow once on running containers, waits for stopped ones, and skips them when asked', async () => {
    await withHarness(async (harness) => {
      const a = await harness.container();
      const b = await harness.container();
      const stopped = await harness.container({ running: false });
      await harness.pass();
      const script = await harness.service.create(harness.adminId, createRequest());
      expect(script.counts).toMatchObject({ pending: 2, waiting: 1 });

      await harness.pass();
      expect(harness.guests.executed.map((run) => run.instance).sort()).toEqual([a.instance, b.instance].sort());
      expect(await targetStates(harness, script.id)).toEqual({ [a.id]: 'succeeded', [b.id]: 'succeeded', [stopped.id]: 'waiting' });

      // Started later: it runs then, once.
      await harness.database.updateTable('control.containers').set({ power_intent: 'running' }).where('id', '=', stopped.id).execute();
      harness.guests.boot(stopped.instance);
      await harness.pass();
      await harness.pass();
      expect(harness.guests.executed.filter((run) => run.instance === stopped.instance)).toHaveLength(1);
      expect((await harness.service.get(script.id)).counts).toMatchObject({ succeeded: 3 });

      const skipping = await harness.service.create(harness.adminId, createRequest({ stoppedPolicy: 'skip' }));
      const late = await harness.container({ running: false });
      await harness.service.publish(harness.adminId, skipping.id, publish({ expectedRevision: skipping.revision, stoppedPolicy: 'skip' }));
      expect((await targetStates(harness, skipping.id))[late.id]).toBe('skipped');
    });
  });

  it('passes the environment, files and timeout to the guest and keeps the output', async () => {
    await withHarness(async (harness) => {
      const container = await harness.container();
      const blob = await harness.service.uploadBlob(harness.adminId, Buffer.from('mirror=1\n'));
      harness.guests.behavior = () => ({ rc: 0, output: 'done ✓\n' });
      const script = await harness.service.create(harness.adminId, createRequest({
        name: 'apt mirror',
        timeoutSeconds: 120,
        files: [{ name: 'sources.list', sha256: blob.sha256, destination: { path: '/etc/apt/sources.list', mode: '0644', owner: 'root' } }],
      }));
      await harness.pass();
      const [run] = harness.guests.executed;
      expect(run!.wrapper).toContain("export NYABASE_SCRIPT_NAME='apt mirror'");
      expect(run!.wrapper).toContain('export NYABASE_TRIGGER=\'now\'');
      expect(run!.wrapper).toContain("install -m 0644 -o 0 -g 0 \"$dir/files/\"'sources.list' '/etc/apt/sources.list''.nyabase-tmp'");
      expect(run!.wrapper).toContain('timeout -k 30 120 "$dir/script"');
      const runs = await harness.service.listRuns(script.id, { limit: 50 });
      expect(runs.items).toHaveLength(1);
      expect(runs.items[0]).toMatchObject({ status: 'succeeded', exitCode: 0, trigger: 'now', attempt: 1, containerId: container.id });
      expect(runs.items[0]!.bootId).toBe(harness.guests.instances.get(container.instance)!.lastUsedAt);
      expect((await harness.service.getRun(script.id, runs.items[0]!.id)).output).toBe('done ✓\n');
      // The run directory is gone from the guest.
      expect([...harness.guests.guestFiles(container.instance).keys()].filter((path) => path.includes(runs.items[0]!.id))).toEqual([]);
    });
  });

  it('retries a failing container with a backoff, then marks it failed; a retry makes it due again', async () => {
    await withHarness(async (harness) => {
      const container = await harness.container();
      harness.guests.behavior = () => ({ rc: 2, output: 'boom\n' });
      const script = await harness.service.create(harness.adminId, createRequest({ maxAttempts: 2, pauseAfterFailures: null }));
      await harness.pass();
      let [target] = await harness.service.listTargets(script.id, {});
      expect(target).toMatchObject({ state: 'pending', attempts: 1 });
      expect(new Date(target!.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now() + 30_000);

      await harness.pass();
      expect(harness.guests.executed).toHaveLength(1);
      await harness.database.updateTable('control.container_script_targets').set({ next_attempt_at: new Date(Date.now() - 1_000) }).execute();
      await harness.pass();
      [target] = await harness.service.listTargets(script.id, {});
      expect(target).toMatchObject({ state: 'failed', attempts: 2, lastRun: { status: 'failed', exitCode: 2 } });

      harness.guests.behavior = () => ({ rc: 0 });
      await harness.service.retry(harness.adminId, script.id, {});
      await harness.pass();
      [target] = await harness.service.listTargets(script.id, {});
      expect(target).toMatchObject({ state: 'succeeded', trigger: 'retry' });
      expect(harness.guests.executed.filter((run) => run.instance === container.instance)).toHaveLength(3);
      expect(harness.audit.append).toHaveBeenCalledWith(expect.anything(), harness.adminId, AuditAction.RetryContainerScript, script.id, 'container_script', expect.objectContaining({ containerIds: [container.id] }));
    });
  });

  it('pauses itself after too many failed containers, and after its canary until resumed', async () => {
    await withHarness(async (harness) => {
      await harness.container();
      await harness.container();
      await harness.container();
      harness.guests.behavior = () => ({ rc: 1 });
      const failing = await harness.service.create(harness.adminId, createRequest({ pauseAfterFailures: 1, maxParallel: 1 }));
      await harness.pass();
      const paused = await harness.service.get(failing.id);
      expect(paused).toMatchObject({ status: 'paused', pauseReason: 'failures' });
      expect(harness.guests.executed).toHaveLength(1);
      expect(harness.audit.append).toHaveBeenCalledWith(expect.anything(), null, AuditAction.AutoPauseContainerScript, failing.id, 'container_script', expect.objectContaining({ reason: 'failures' }));
      await harness.service.archive(harness.adminId, failing.id, paused.revision);

      harness.guests.executed.length = 0;
      harness.guests.behavior = () => ({ rc: 0 });
      const canary = await harness.service.create(harness.adminId, createRequest({ canaryCount: 1 }));
      await harness.pass();
      await harness.pass();
      const held = await harness.service.get(canary.id);
      expect(held).toMatchObject({ status: 'paused', pauseReason: 'canary', counts: { succeeded: 1, pending: 2 } });
      expect(harness.guests.executed).toHaveLength(1);

      await harness.service.resume(harness.adminId, canary.id, held.revision);
      await harness.pass();
      expect((await harness.service.get(canary.id)).counts).toMatchObject({ succeeded: 3 });
    });
  });

  it('runs scripts on one container one at a time, lowest priority number first, and failures do not hold back the next', async () => {
    await withHarness(async (harness) => {
      const container = await harness.container();
      harness.guests.behavior = ({ script }) => ({ rc: script.includes('second') ? 0 : 1 });
      const second = await harness.service.create(harness.adminId, createRequest({ priority: 20, script: '#!/bin/sh\necho second\n' }));
      const first = await harness.service.create(harness.adminId, createRequest({ priority: 10, script: '#!/bin/sh\necho first\n', maxAttempts: 1 }));
      await harness.pass();
      await harness.pass();
      expect(harness.guests.executed.map((run) => run.script)).toEqual(['#!/bin/sh\necho first\n', '#!/bin/sh\necho second\n']);
      expect((await targetStates(harness, first.id))[container.id]).toBe('failed');
      expect((await targetStates(harness, second.id))[container.id]).toBe('succeeded');
      const runs = await harness.database.selectFrom('control.container_script_runs').select(['started_at', 'finished_at']).orderBy('started_at').execute();
      expect(runs[1]!.started_at.getTime()).toBeGreaterThanOrEqual(runs[0]!.finished_at!.getTime());
    });
  });

  it('takes new containers when asked, and treats containers existing at a publish without applyNow as exempt', async () => {
    await withHarness(async (harness) => {
      const old = await harness.container();
      const onlyNew = await harness.service.create(harness.adminId, createRequest({ applyNow: false, onNewContainers: true }));
      const nowOnly = await harness.service.create(harness.adminId, createRequest({ applyNow: true, onNewContainers: false }));
      expect((await targetStates(harness, onlyNew.id))[old.id]).toBe('exempt');
      await harness.pass();
      const fresh = await harness.container();
      await harness.pass();
      expect((await targetStates(harness, onlyNew.id))).toEqual({ [old.id]: 'exempt', [fresh.id]: 'succeeded' });
      expect((await targetStates(harness, nowOnly.id))).toEqual({ [old.id]: 'succeeded' });
      const ran = await harness.service.listRuns(onlyNew.id, { limit: 50 });
      expect(ran.items.map((run) => run.trigger)).toEqual(['new_container']);
    });
  });

  it('moves unfinished containers to a version published without applyNow and leaves finished ones alone', async () => {
    await withHarness(async (harness) => {
      const ok = await harness.container();
      const bad = await harness.container();
      harness.guests.behavior = ({ instance }) => ({ rc: instance === bad.instance ? 1 : 0 });
      const script = await harness.service.create(harness.adminId, createRequest({ maxAttempts: 1, pauseAfterFailures: null }));
      await harness.pass();
      expect(await targetStates(harness, script.id)).toEqual({ [ok.id]: 'succeeded', [bad.id]: 'failed' });

      harness.guests.behavior = () => ({ rc: 0 });
      const fixed = await harness.service.publish(harness.adminId, script.id, publish({ expectedRevision: script.revision, applyNow: false, maxAttempts: 1 }));
      expect(fixed.current.version).toBe(2);
      await harness.pass();
      const targets = await harness.service.listTargets(script.id, {});
      expect(targets.find((target) => target.containerId === ok.id)).toMatchObject({ state: 'succeeded', version: 1 });
      expect(targets.find((target) => target.containerId === bad.id)).toMatchObject({ state: 'succeeded', version: 2 });

      const again = await harness.service.publish(harness.adminId, script.id, publish({ expectedRevision: fixed.revision, applyNow: true }));
      await harness.pass();
      expect((await harness.service.get(script.id)).counts).toMatchObject({ succeeded: 2 });
      expect(harness.guests.executed.filter((run) => run.script.includes('v2'))).toHaveLength(3);
      await expect(harness.service.publish(harness.adminId, script.id, publish({ expectedRevision: fixed.revision })))
        .rejects.toMatchObject({ response: { code: FailureCode.RevisionConflict } });
      expect(again.current.version).toBe(3);
    });
  });

  it('runs an every-boot script after each boot it has not seen, and only then', async () => {
    await withHarness(async (harness) => {
      // Never observed before the publish: its current boot is not a new one.
      const container = await harness.container();
      const script = await harness.service.create(harness.adminId, createRequest({ everyBoot: true, applyNow: false }));
      expect(script.current.onNewContainers).toBe(true);
      await harness.pass();
      expect(harness.guests.executed).toHaveLength(0);
      expect((await targetStates(harness, script.id))[container.id]).toBe('exempt');

      harness.guests.boot(container.instance);
      await harness.pass();
      await harness.pass();
      expect(harness.guests.executed).toHaveLength(1);
      expect((await harness.service.listRuns(script.id, { limit: 50 })).items[0]).toMatchObject({ trigger: 'boot', status: 'succeeded' });

      harness.guests.boot(container.instance);
      await harness.pass();
      expect(harness.guests.executed).toHaveLength(2);

      // A new container's first boot is a boot.
      const fresh = await harness.container();
      await harness.pass();
      expect(harness.guests.executed.map((run) => run.instance)).toContain(fresh.instance);

      // applyNow on a new version: the running containers run it in their current boot.
      const current = await harness.service.get(script.id);
      await harness.service.publish(harness.adminId, script.id, publish({ expectedRevision: current.revision, applyNow: true }));
      await harness.pass();
      expect(harness.guests.executed.filter((run) => run.script.includes('v2'))).toHaveLength(2);
    });
  });

  it('resumes a run after a Backend restart from the result the guest left', async () => {
    await withHarness(async (harness) => {
      const container = await harness.container();
      harness.guests.execError = new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected', phase: 'in_flight' });
      const script = await harness.service.create(harness.adminId, createRequest({ timeoutSeconds: 10 }));
      // The exec "may have started": the run keeps waiting for a result in the guest.
      const pass = harness.scheduler.process();
      await vi_waitFor(async () => (await harness.database.selectFrom('control.container_script_runs').selectAll().execute()).length === 1);
      await pass;
      const [running] = await harness.database.selectFrom('control.container_script_runs').selectAll().execute();
      expect(running!.status).toBe('running');

      const restarted = await harness.restart();
      const dir = `/var/lib/nyabase/script-runs/${running!.id}`;
      harness.guests.guestFiles(container.instance).set(`${dir}/output`, { body: Buffer.from('late\n'), type: 'file' });
      harness.guests.guestFiles(container.instance).set(`${dir}/rc`, { body: Buffer.from('0\n'), type: 'file' });
      await restarted.process();
      await restarted.settle();
      const run = await harness.service.getRun(script.id, running!.id);
      expect(run).toMatchObject({ status: 'succeeded', output: 'late\n' });
      expect((await targetStates(harness, script.id))[container.id]).toBe('succeeded');
    });
  });

  it('abandons a start whose exec never left (no agent), without counting the attempt', async () => {
    await withHarness(async (harness) => {
      await harness.container();
      harness.guests.execError = new IncusError('SERVER_UNREACHABLE', 'retry', { reason: 'agent_disconnected' });
      const script = await harness.service.create(harness.adminId, createRequest());
      await harness.pass();
      const [target] = await harness.service.listTargets(script.id, {});
      expect(target).toMatchObject({ state: 'pending', attempts: 0 });
      expect(await harness.database.selectFrom('control.container_script_runs').selectAll().execute()).toHaveLength(0);
    });
  });

  it('abandons a start whose container turned out not to be running, without counting the attempt', async () => {
    await withHarness(async (harness) => {
      const container = await harness.container();
      await harness.pass();
      // Observed running, but stopped by the time the run starts.
      harness.guests.stop(container.instance);
      (harness.scheduler as unknown as { observe: () => Promise<void> }).observe = async () => undefined;
      const script = await harness.service.create(harness.adminId, createRequest());
      await harness.scheduler.process();
      await harness.scheduler.settle();
      const [target] = await harness.service.listTargets(script.id, {});
      expect(target).toMatchObject({ state: 'pending', attempts: 0 });
      expect(new Date(target!.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());
      expect(await harness.database.selectFrom('control.container_script_runs').selectAll().execute()).toHaveLength(0);
    });
  });

  it('keeps names and priorities unique among live scripts and checks uploads', async () => {
    await withHarness(async (harness) => {
      const first = await harness.service.create(harness.adminId, createRequest({ name: 'same' }));
      expect(first.priority).toBe(10);
      const second = await harness.service.create(harness.adminId, createRequest());
      expect(second.priority).toBe(20);
      await expect(harness.service.create(harness.adminId, createRequest({ name: 'same' })))
        .rejects.toMatchObject({ response: { code: FailureCode.ContainerScriptConflict, details: { field: 'name' } } });
      await expect(harness.service.patch(harness.adminId, second.id, { expectedRevision: second.revision, priority: 10 }))
        .rejects.toMatchObject({ response: { code: FailureCode.ContainerScriptConflict, details: { field: 'priority' } } });
      await harness.service.archive(harness.adminId, first.id, first.revision);
      await expect(harness.service.create(harness.adminId, createRequest({ name: 'same', priority: 10 }))).resolves.toBeDefined();
      await expect(harness.service.publish(harness.adminId, first.id, publish({ expectedRevision: first.revision + 1 })))
        .rejects.toMatchObject({ response: { code: FailureCode.ContainerScriptArchived } });
      await expect(harness.service.create(harness.adminId, createRequest({ files: [{ name: 'x', sha256: 'f'.repeat(64), destination: null }] })))
        .rejects.toMatchObject({ response: { code: FailureCode.ContainerScriptBlobMissing } });
    });
  });

  it('shows owners the scripts run in their container, and nobody else', async () => {
    await withHarness(async (harness) => {
      const container = await harness.container();
      const script = await harness.service.create(harness.adminId, createRequest({ name: 'tasksmax' }));
      await harness.service.create(harness.adminId, createRequest({ name: 'unrelated', applyNow: false }));
      await harness.pass();
      const owner = { userId: harness.ownerId, role: 'user', authKind: 'jwt', authVersion: 0 } as const;
      const items = await harness.maintenance.list(owner as never, container.id, 'mine');
      expect(items).toEqual([{
        scriptId: script.id,
        name: 'tasksmax',
        everyBoot: false,
        state: 'succeeded',
        lastRun: { status: 'succeeded', startedAt: expect.any(String), finishedAt: expect.any(String) },
      }]);
      const stranger = { ...owner, userId: await seedUser(harness.database) };
      await expect(harness.maintenance.list(stranger as never, container.id, 'mine')).rejects.toThrow('Container not found');
    });
  });
});

/** Polls `check` until it holds (or 5 s pass). */
async function vi_waitFor(check: () => Promise<boolean>): Promise<void> {
  const until = Date.now() + 5_000;
  while (!(await check())) {
    if (Date.now() > until) throw new Error('condition not met');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describePg('container script scope in SQL', () => {
  it('matches exactly what the common scope rule matches', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const users = [await seedUser(database), await seedUser(database)];
      const servers = [await seedServer(database), await seedServer(database)];
      const harness = await scriptHarness(database);
      await harness.stop();
      const containers: Array<{ id: string; serverId: string; imageId: string; ownerId: string }> = [];
      for (const serverId of servers) {
        const poolId = await seedPool(database, serverId);
        for (const ownerId of users) {
          const id = await seedContainer(database, { ownerId, serverId, poolId, imageId: harness.imageId });
          containers.push({ id, serverId, imageId: harness.imageId, ownerId });
        }
      }
      const scopes: ContainerScriptScope[] = [
        { all: true },
        { all: true, excludeContainerIds: [containers[0]!.id] },
        { serverIds: [servers[0]!] },
        { serverIds: [servers[0]!], ownerIds: [users[1]!] },
        { ownerIds: users, containerIds: [containers[3]!.id, containers[1]!.id] },
        { imageIds: [harness.imageId], excludeContainerIds: [containers[2]!.id] },
        { imageIds: [randomUUID()] },
      ].map((scope) => zContainerScriptScope.parse(scope));
      for (const scope of scopes) {
        const matched = await matchedInSql(database, scope, containers.map((container) => container.id));
        const expected = containers.filter((container) => containerScriptScopeMatches(scope, container)).map((container) => container.id).sort();
        expect(matched, JSON.stringify(scope)).toEqual(expected);
      }
    });
  });
});

async function matchedInSql(database: Kysely<NyabaseDatabase>, scope: ContainerScriptScope, ids: string[]): Promise<string[]> {
  const result = await sql<{ id: string }>`
    SELECT c.id FROM control.containers AS c, (
      SELECT ${scope.all}::boolean AS scope_all,
        ${sql`${scope.serverIds}::uuid[]`} AS scope_server_ids,
        ${sql`${scope.imageIds}::uuid[]`} AS scope_image_ids,
        ${sql`${scope.ownerIds}::uuid[]`} AS scope_owner_ids,
        ${sql`${scope.containerIds}::uuid[]`} AS scope_container_ids,
        ${sql`${scope.excludeContainerIds}::uuid[]`} AS scope_exclude_container_ids
    ) AS v
    WHERE c.id = ANY(${sql`${ids}::uuid[]`}) AND ${scopeMatchSql('v', 'c')}
    ORDER BY c.id
  `.execute(database);
  return result.rows.map((row) => row.id).sort();
}
