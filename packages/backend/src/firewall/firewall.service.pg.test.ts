import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import {
  AuditAction,
  FailureCode,
  FIREWALL_MAX_CIDRS_PER_SERVER,
  FIREWALL_MAX_RULES_PER_SERVER,
  firewallDigestInput,
  zCreateFirewallRuleRequest,
  zFirewallDocument,
  zPatchFirewallRuleRequest,
  type AgentHostStatus,
  type FirewallDocument,
  type FirewallRuleSpec,
} from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { seedServer, seedUser } from '../iam/access.pg-test-helper.js';
import type { AgentPresenceListener } from '../incus/agent-registry.service.js';
import type { NyabaseDatabase } from '../platform/persistence-pg/database.types.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { FirewallSyncService } from './firewall-sync.service.js';
import { FirewallRepository } from './firewall.repository.js';
import { FirewallService } from './firewall.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

function harness(database: Kysely<NyabaseDatabase>, sync: { rulesChanged: (ids: Iterable<string>) => void } = {
  rulesChanged: vi.fn(),
}) {
  const append = vi.fn().mockResolvedValue(undefined);
  const service = new FirewallService(
    new FirewallRepository(database),
    new PgTransactionManager(database),
    { append } as never,
    sync as never,
  );
  return { service, append, sync };
}

const create = (input: Record<string, unknown>) => zCreateFirewallRuleRequest.parse({
  action: 'drop',
  protocol: 'all',
  cidrs: ['10.0.0.0/8'],
  ...input,
});
const patch = (input: Record<string, unknown>) => zPatchFirewallRuleRequest.parse(input);

describePg('firewall rules', () => {
  it('stores canonical rules, checks the revision, and syncs every server before and after a change', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedUser(database);
      const serverA = await seedServer(database, 'fw-a');
      const serverB = await seedServer(database, 'fw-b');
      const { service, append, sync } = harness(database);

      const rule = await service.create(actorId, create({
        name: ' block-lan ',
        priority: 20,
        protocol: 'tcp',
        ports: [{ from: 80, to: 90 }, { from: 22, to: 22 }, { from: 85, to: 100 }],
        cidrs: ['10.1.2.3/8', '192.168.1.7', '10.0.0.0/8'],
        serverIds: [serverB, serverA],
      }));
      expect(rule).toMatchObject({
        name: 'block-lan',
        priority: 20,
        ports: [{ from: 22, to: 22 }, { from: 80, to: 100 }],
        cidrs: ['10.0.0.0/8', '192.168.1.7/32'],
        serverIds: [serverA, serverB].sort(),
        revision: 1,
      });
      expect(sync.rulesChanged).toHaveBeenLastCalledWith([serverB, serverA]);
      expect(append).toHaveBeenLastCalledWith(
        expect.anything(),
        actorId,
        AuditAction.CreateFirewallRule,
        rule.id,
        'firewall_rule',
        expect.objectContaining({ cidrs: rule.cidrs, ports: rule.ports, serverIds: [serverA, serverB].sort() }),
      );

      await expect(service.patch(actorId, rule.id, patch({ expectedRevision: 2, name: 'x' })))
        .rejects.toMatchObject({ response: { code: FailureCode.RevisionConflict } });
      // `all` with the rule's existing ports is refused on the merged value.
      await expect(service.patch(actorId, rule.id, patch({ expectedRevision: 1, protocol: 'all' })))
        .rejects.toMatchObject({ response: { code: FailureCode.InvalidInput } });

      const moved = await service.patch(actorId, rule.id, patch({
        expectedRevision: 1,
        protocol: 'all',
        ports: [],
        serverIds: [serverB],
      }));
      expect(moved).toMatchObject({ protocol: 'all', ports: [], serverIds: [serverB], revision: 2, name: 'block-lan' });
      expect(new Set(vi.mocked(sync.rulesChanged).mock.lastCall![0])).toEqual(new Set([serverA, serverB]));
      expect(append).toHaveBeenLastCalledWith(
        expect.anything(),
        actorId,
        AuditAction.UpdateFirewallRule,
        rule.id,
        'firewall_rule',
        expect.objectContaining({ changed: ['ports', 'protocol', 'serverIds'], serverIds: [serverB], revision: 2 }),
      );

      expect((await service.list()).map((item) => item.id)).toEqual([rule.id]);
      await service.delete(actorId, rule.id);
      expect(sync.rulesChanged).toHaveBeenLastCalledWith([serverB]);
      expect(append).toHaveBeenLastCalledWith(
        expect.anything(),
        actorId,
        AuditAction.DeleteFirewallRule,
        rule.id,
        'firewall_rule',
        expect.objectContaining({ name: 'block-lan', serverIds: [serverB] }),
      );
      await expect(service.get(rule.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('refuses duplicate names and priorities, unknown servers, and does not sync a rolled-back write', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedUser(database);
      const server = await seedServer(database, 'fw-dup');
      const { service, sync } = harness(database);
      const first = await service.create(actorId, create({ name: 'one', priority: 10, serverIds: [server] }));
      const second = await service.create(actorId, create({ name: 'two', priority: 20 }));
      vi.mocked(sync.rulesChanged).mockClear();

      await expect(service.create(actorId, create({ name: 'one', priority: 30 }))).rejects.toMatchObject({
        response: { code: FailureCode.FirewallRuleConflict, details: { field: 'name', conflictingRuleId: first.id } },
      });
      await expect(service.patch(actorId, second.id, patch({ expectedRevision: 1, priority: 10 }))).rejects.toMatchObject({
        response: { code: FailureCode.FirewallRuleConflict, details: { field: 'priority', conflictingRuleId: first.id } },
      });
      await expect(service.create(actorId, create({
        name: 'three',
        priority: 30,
        serverIds: ['00000000-0000-4000-8000-000000000000'],
      }))).rejects.toMatchObject({ response: { code: FailureCode.InvalidInput } });
      expect(sync.rulesChanged).not.toHaveBeenCalled();
      expect(await service.list()).toHaveLength(2);
    });
  });

  it('keeps every server within the rule and CIDR limits', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedUser(database);
      const full = await seedServer(database, 'fw-full');
      const other = await seedServer(database, 'fw-other');
      const { service } = harness(database);
      const cidrs = Array.from({ length: 256 }, (_, index) => `10.${Math.floor(index / 256)}.${index % 256}.0/24`);
      for (let index = 0; index < FIREWALL_MAX_CIDRS_PER_SERVER / 256; index += 1) {
        await service.create(actorId, create({ name: `wide-${index}`, priority: index + 1, cidrs, serverIds: [full] }));
      }
      await expect(service.create(actorId, create({
        name: 'one-more',
        priority: 1_000,
        serverIds: [other, full],
      }))).rejects.toMatchObject({
        response: { code: FailureCode.FirewallTooLarge, details: { serverId: full, cidrs: FIREWALL_MAX_CIDRS_PER_SERVER + 1 } },
      });
      const elsewhere = await service.create(actorId, create({ name: 'one-more', priority: 1_000, serverIds: [other] }));
      // Moving onto the full server is a change that counts, too.
      await expect(service.patch(actorId, elsewhere.id, patch({ expectedRevision: 1, serverIds: [other, full] })))
        .rejects.toMatchObject({ response: { code: FailureCode.FirewallTooLarge, details: { serverId: full } } });
      // Editing a rule already on the server does not count it twice.
      const [first] = await service.list();
      await expect(service.patch(actorId, first!.id, patch({ expectedRevision: 1, cidrs: ['10.0.0.0/8'] })))
        .resolves.toMatchObject({ cidrs: ['10.0.0.0/8'] });

      const many = await seedServer(database, 'fw-many');
      await database.insertInto('infra.firewall_rules').values(
        Array.from({ length: FIREWALL_MAX_RULES_PER_SERVER }, (_, index) => ({
          id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          name: `bulk-${index}`,
          priority: 10_000 + index,
          action: 'accept' as const,
          protocol: 'all' as const,
          ports: '[]',
          cidrs: '["10.9.0.0/16"]',
          revision: 1,
        })),
      ).execute();
      await database.insertInto('infra.firewall_rule_servers').values(
        Array.from({ length: FIREWALL_MAX_RULES_PER_SERVER }, (_, index) => ({
          rule_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          server_id: many,
        })),
      ).execute();
      await expect(service.create(actorId, create({ name: 'too-many', priority: 999_999, serverIds: [many] })))
        .rejects.toMatchObject({
          response: { code: FailureCode.FirewallTooLarge, details: { serverId: many, rules: FIREWALL_MAX_RULES_PER_SERVER + 1 } },
        });
    });
  });

  it('answers 400 rather than a foreign key error when a server is deleted concurrently', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedUser(database);
      const server = await seedServer(database, 'fw-race');
      const { service } = harness(database);
      let creating: Promise<unknown> | undefined;
      await database.transaction().execute(async (transaction) => {
        await transaction.deleteFrom('infra.servers').where('id', '=', server).execute();
        creating = service.create(actorId, create({ name: 'race', priority: 1, serverIds: [server] }))
          .then(() => 'created', (error: unknown) => error);
        // Let the create reach the server row lock and wait on this delete.
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      await expect(creating).resolves.toMatchObject({ response: { code: FailureCode.InvalidInput } });
      expect(await service.list()).toEqual([]);
    });
  });

  it('pushes the committed rules to connected agents and reports their state', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const actorId = await seedUser(database);
      const server = await seedServer(database, 'fw-sync');
      const idle = await seedServer(database, 'fw-idle');
      let listener!: AgentPresenceListener;
      let status: AgentHostStatus = {
        ipv6Guard: { present: true, error: null },
        firewall: { present: false, digest: null, error: null },
      };
      const applied: FirewallDocument[] = [];
      const connection = {
        get status() {
          return status;
        },
        applyFirewall: vi.fn(async (document: FirewallDocument) => {
          applied.push(document);
          status = { ...status, firewall: { present: true, digest: document.digest, error: null } };
          return document.digest;
        }),
      };
      const agents = {
        onPresence: (value: AgentPresenceListener) => {
          listener = value;
          return () => undefined;
        },
        current: (serverId: string) => (serverId === server ? connection : undefined),
        isConnected: (serverId: string) => serverId === server,
      };
      const repository = new FirewallRepository(database);
      const sync = new FirewallSyncService(agents as never, repository);
      sync.onModuleInit();
      const { service } = harness(database, sync);
      const empty = createHash('sha256').update(firewallDigestInput([])).digest('hex');

      await listener.connected(server, {} as never);
      await vi.waitFor(() => expect(applied).toHaveLength(1));
      expect(applied[0]).toEqual({ digest: empty, rules: [] });
      // Exactly what the agent accepts (strict schema: no extra fields).
      expect(zFirewallDocument.safeParse(applied[0]).success).toBe(true);

      await service.create(actorId, create({
        name: 'dns',
        priority: 5,
        action: 'accept',
        protocol: 'udp',
        ports: [{ from: 53, to: 53 }],
        cidrs: ['10.0.0.53'],
        serverIds: [server, idle],
      }));
      await service.create(actorId, create({ name: 'lan', priority: 1, serverIds: [server] }));
      await vi.waitFor(() => expect(applied.at(-1)?.rules).toHaveLength(2));
      const rules: FirewallRuleSpec[] = [
        { action: 'drop', protocol: 'all', cidrs: ['10.0.0.0/8'], ports: [] },
        { action: 'accept', protocol: 'udp', cidrs: ['10.0.0.53/32'], ports: [{ from: 53, to: 53 }] },
      ];
      expect(applied.at(-1)).toEqual({
        digest: createHash('sha256').update(firewallDigestInput(rules)).digest('hex'),
        rules,
      });
      expect(zFirewallDocument.safeParse(applied.at(-1)).success).toBe(true);

      const statuses = await service.status();
      expect(statuses).toEqual([
        expect.objectContaining({ serverId: idle, state: 'offline', agentConnected: false, ruleCount: 1, appliedDigest: null }),
        expect.objectContaining({ serverId: server, state: 'synced', agentConnected: true, ruleCount: 2, error: null }),
      ]);
      await expect(sync.agentStatuses([server, idle])).resolves.toEqual(new Map([
        [server, { state: 'synced', error: null }],
        [idle, null],
      ]));
      sync.onModuleDestroy();
    });
  });
});
