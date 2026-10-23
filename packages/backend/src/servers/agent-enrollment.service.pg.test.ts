import { describe, expect, it, vi } from 'vitest';
import { AgentCredentialRejections } from '../incus/agent-credentials.js';
import { AgentCredentialVerifier } from '../incus/agent-credentials.js';
import { seedServer } from '../iam/access.pg-test-helper.js';
import { withPostgresTestDatabase } from '../platform/persistence-pg/postgres-test-harness.js';
import { PgTransactionManager } from '../platform/persistence-pg/transaction.js';
import { AgentEnrollmentService } from './agent-enrollment.service.js';

const describePg = process.env.NYABASE_TEST_DATABASE_URL ? describe : describe.skip;

describePg('agent enrollment retries', () => {
  it('keeps the token usable until the agent first authenticates, rotating the credential each time', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const agents = { disconnect: vi.fn() };
      const enrollment = new AgentEnrollmentService(
        database,
        new PgTransactionManager(database),
        { append: vi.fn() } as never,
        agents as never,
      );
      const rejections = new AgentCredentialRejections();
      const verifier = new AgentCredentialVerifier(database, rejections);
      const serverId = await seedServer(database);
      const { enrollmentToken } = await database.transaction().execute(
        (transaction) => enrollment.issueInTransaction(transaction, serverId),
      );

      // The first response never reached the agent; it retries with the same token.
      const lost = await enrollment.enroll({ enrollmentToken, hostname: 'worker-1' });
      const retried = await enrollment.enroll({ enrollmentToken, hostname: 'worker-1' });
      expect(retried.credential).not.toBe(lost.credential);
      expect(agents.disconnect).toHaveBeenCalledTimes(2);
      await expect(verifier.authenticate(`Bearer ${lost.credential}`, '192.0.2.10')).resolves.toBeUndefined();
      expect(rejections.list()).toMatchObject([
        { serverId, reason: 'bad_secret', clientAddress: '192.0.2.10', attempts: 1 },
      ]);
      await expect(verifier.confirmControl(serverId, `Bearer ${lost.credential}`)).resolves.toBe(false);
      // A failed confirmation does not spend the token.
      const pending = await database
        .selectFrom('infra.servers')
        .select(['agent_enrollment_token_hash', 'agent_credential_unconfirmed'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(pending).toMatchObject({ agent_credential_unconfirmed: true });
      expect(pending.agent_enrollment_token_hash).not.toBeNull();

      await expect(verifier.authenticate(`Bearer ${retried.credential}`)).resolves.toBe(serverId);
      expect(rejections.list()).toEqual([]);
      await expect(verifier.confirmControl(serverId, `Bearer ${retried.credential}`)).resolves.toBe(true);
      const spent = await database
        .selectFrom('infra.servers')
        .select(['agent_enrollment_token_hash', 'agent_enrollment_expires_at', 'agent_credential_unconfirmed'])
        .where('id', '=', serverId)
        .executeTakeFirstOrThrow();
      expect(spent).toEqual({
        agent_enrollment_token_hash: null,
        agent_enrollment_expires_at: null,
        agent_credential_unconfirmed: false,
      });
      await expect(enrollment.enroll({ enrollmentToken, hostname: 'worker-1' })).rejects.toMatchObject({ status: 401 });
      // Later reconnects keep working and change nothing.
      await expect(verifier.confirmControl(serverId, `Bearer ${retried.credential}`)).resolves.toBe(true);
    });
  });

  it('does not spend a freshly issued token when the running agent reconnects', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const enrollment = new AgentEnrollmentService(
        database,
        new PgTransactionManager(database),
        { append: vi.fn() } as never,
        { disconnect: vi.fn() } as never,
      );
      const verifier = new AgentCredentialVerifier(database, new AgentCredentialRejections());
      const serverId = await seedServer(database);
      const issue = () => database.transaction().execute(
        (transaction) => enrollment.issueInTransaction(transaction, serverId),
      );
      const first = await enrollment.enroll({ enrollmentToken: (await issue()).enrollmentToken, hostname: 'a' });
      await expect(verifier.confirmControl(serverId, `Bearer ${first.credential}`)).resolves.toBe(true);

      // An operator re-issues a token for a reinstall; the old agent keeps running meanwhile.
      const reissued = await issue();
      await expect(verifier.confirmControl(serverId, `Bearer ${first.credential}`)).resolves.toBe(true);
      const second = await enrollment.enroll({ enrollmentToken: reissued.enrollmentToken, hostname: 'b' });
      await expect(verifier.confirmControl(serverId, `Bearer ${first.credential}`)).resolves.toBe(false);
      await expect(verifier.confirmControl(serverId, `Bearer ${second.credential}`)).resolves.toBe(true);
    });
  });

  it('refuses a deleted server or a credential naming another server, recording the unknown server', async () => {
    await withPostgresTestDatabase(async ({ database }) => {
      const enrollment = new AgentEnrollmentService(
        database,
        new PgTransactionManager(database),
        { append: vi.fn() } as never,
        { disconnect: vi.fn() } as never,
      );
      const rejections = new AgentCredentialRejections();
      const verifier = new AgentCredentialVerifier(database, rejections);
      const serverId = await seedServer(database);
      const otherId = await seedServer(database);
      const { enrollmentToken } = await database.transaction().execute(
        (transaction) => enrollment.issueInTransaction(transaction, serverId),
      );
      const { credential } = await enrollment.enroll({ enrollmentToken, hostname: 'a' });
      await expect(verifier.confirmControl(otherId, `Bearer ${credential}`)).resolves.toBe(false);
      await database.deleteFrom('infra.servers').where('id', '=', serverId).execute();
      await expect(verifier.confirmControl(serverId, `Bearer ${credential}`)).resolves.toBe(false);
      // As a host enrolled after the backup a restore came from would: operators see the server id it claims.
      await expect(verifier.authenticate(`Bearer ${credential}`, '192.0.2.11')).resolves.toBeUndefined();
      expect(rejections.list()).toMatchObject([
        { serverId, reason: 'unknown_server', clientAddress: '192.0.2.11', attempts: 1 },
      ]);
    });
  });
});
