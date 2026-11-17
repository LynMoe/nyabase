// Container scripts on real guests through the agent: once-scripts with files,
// every-boot scripts across an in-guest reboot and a restart, failures,
// retries and timeouts, and what the owner sees.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type {
  ContainerDto,
  ContainerMaintenanceItemDto,
  ContainerScriptBlobDto,
  ContainerScriptDto,
  ContainerScriptRunDto,
  ContainerScriptRunPageDto,
  ContainerScriptTargetDto,
  CreateContainerScriptRequest,
} from '@nyabase/common';
import { Harness, type TestUser } from '../client/harness.js';
import { pollUntil } from '../client/poll.js';

describe('container scripts', () => {
  let h: Harness;
  let owner: TestUser;
  let container: ContainerDto;

  before(async () => {
    h = await Harness.start();
    owner = await h.newUser('scripts');
    await h.grantServer(owner, h.server);
    container = await h.createContainer(owner, h.server);
  });
  after(async () => h?.cleanup());

  /** A script scoped to this scenario's container only; archived on cleanup. */
  async function createScript(input: Partial<CreateContainerScriptRequest> & Pick<CreateContainerScriptRequest, 'script'>) {
    const created = await h.api.post<ContainerScriptDto>('/admin/container-scripts', {
      name: h.name('script'),
      scope: { containerIds: [container.id] },
      pauseAfterFailures: null,
      ...input,
    });
    h.defer(`archive script ${created.name}`, async () => {
      const current = await h.api.get<ContainerScriptDto>(`/admin/container-scripts/${created.id}`);
      if (current.status !== 'archived') {
        await h.api.post(`/admin/container-scripts/${created.id}/archive`, { expectedRevision: current.revision });
      }
    });
    return created;
  }

  async function target(scriptId: string): Promise<ContainerScriptTargetDto> {
    const [only] = await h.api.get<ContainerScriptTargetDto[]>(`/admin/container-scripts/${scriptId}/targets`);
    assert.ok(only, 'the container is the script\'s only target');
    return only;
  }

  function settled(scriptId: string, states: readonly string[], what: string, timeoutMs = 240_000) {
    return pollUntil(async () => {
      const current = await target(scriptId);
      return states.includes(current.state) ? current : undefined;
    }, { timeoutMs, intervalMs: 3_000, what });
  }

  async function runs(scriptId: string): Promise<ContainerScriptRunPageDto['items']> {
    return (await h.api.get<ContainerScriptRunPageDto>(`/admin/container-scripts/${scriptId}/runs`)).items;
  }

  it('installs files and runs a once-script as root, and shows its owner the result', async () => {
    const greeting = await h.api.upload<ContainerScriptBlobDto>('/admin/container-scripts/blobs', Buffer.from('hello-e2e\n'));
    const script = await createScript({
      script: [
        '#!/bin/sh',
        'set -eu',
        'id -u',
        'cat /etc/nyabase-e2e/greeting',
        'echo "$NYABASE_TRIGGER $NYABASE_CONTAINER_NAME"',
        'stat -c "%a %U" /etc/nyabase-e2e/greeting',
        'test -f "$NYABASE_FILES_DIR/greeting"',
        '',
      ].join('\n'),
      files: [{
        name: 'greeting',
        sha256: greeting.sha256,
        destination: { path: '/etc/nyabase-e2e/greeting', mode: '0640', owner: 'login_user' },
      }],
    });
    const done = await settled(script.id, ['succeeded', 'failed'], 'the once-script to finish');
    assert.equal(done.state, 'succeeded', JSON.stringify(done));
    const [run] = await runs(script.id);
    const detail = await h.api.get<ContainerScriptRunDto>(`/admin/container-scripts/${script.id}/runs/${run!.id}`);
    assert.equal(detail.output, `0\nhello-e2e\nnow ${container.name}\n640 ${container.ssh.loginUser}\n`);
    assert.equal(detail.exitCode, 0);
    assert.ok(detail.bootId, 'the run records the boot it ran in');

    const seen = await owner.session.api.get<ContainerMaintenanceItemDto[]>(`/containers/${container.id}/maintenance`);
    assert.deepEqual(seen.map((item) => [item.scriptId, item.state, item.lastRun?.status]), [[script.id, 'succeeded', 'succeeded']]);
    assert.equal(await owner.session.api.status('GET', `/admin/container-scripts/${script.id}`), 403);
  });

  it('runs an every-boot script after an in-guest reboot and after a restart', async () => {
    const script = await createScript({ everyBoot: true, script: '#!/bin/sh\necho "boot $NYABASE_TRIGGER"\n' });
    await settled(script.id, ['succeeded'], 'the every-boot script to run now');
    assert.equal((await runs(script.id)).length, 1);

    await h.incus(h.server, ['exec', container.instanceName!, '--', 'systemctl', 'reboot']);
    await pollUntil(async () => ((await runs(script.id)).filter((run) => run.status === 'succeeded').length >= 2 ? true : undefined), {
      timeoutMs: 300_000,
      intervalMs: 3_000,
      what: 'a run after the in-guest reboot',
    });
    // Right after the reboot, before any scan records the new start: the restart must
    // still restart the instance (it once counted the reboot as the restart).
    await h.power(owner.session.api, container.id, 'restart');
    await pollUntil(async () => ((await runs(script.id)).filter((run) => run.status === 'succeeded').length >= 3 ? true : undefined), {
      timeoutMs: 300_000,
      intervalMs: 3_000,
      what: 'a run after the restart',
    });
    const all = await runs(script.id);
    assert.deepEqual(all.map((run) => run.trigger).sort(), ['boot', 'boot', 'now']);
    assert.equal(new Set(all.map((run) => run.bootId)).size, 3, 'each run belongs to a different boot');
  });

  it('marks a failing script failed with its output, and a retry runs it again', async () => {
    const script = await createScript({
      maxAttempts: 1,
      script: '#!/bin/sh\ntest -e /tmp/nyabase-e2e-ok || { echo missing >&2; exit 3; }\necho fixed\n',
    });
    const failed = await settled(script.id, ['failed'], 'the failing script to fail');
    assert.equal(failed.lastRun?.exitCode, 3);
    const run = await h.api.get<ContainerScriptRunDto>(`/admin/container-scripts/${script.id}/runs/${failed.lastRun!.id}`);
    assert.equal(run.output, 'missing\n');

    await h.incus(h.server, ['exec', container.instanceName!, '--', 'touch', '/tmp/nyabase-e2e-ok']);
    await h.api.post(`/admin/container-scripts/${script.id}/retry`, {});
    const fixed = await settled(script.id, ['succeeded'], 'the retried script to succeed');
    assert.equal(fixed.trigger, 'retry');
  });

  it('times a long script out and kills it', async () => {
    const script = await createScript({
      maxAttempts: 1,
      timeoutSeconds: 10,
      script: '#!/bin/sh\necho started\nsleep 600\n',
    });
    const done = await settled(script.id, ['failed'], 'the slow script to time out', 300_000);
    assert.equal(done.lastRun?.status, 'timed_out');
    const left = await h.incus(h.server, ['exec', container.instanceName!, '--', 'sh', '-c', 'pgrep -c -x sleep || true']);
    assert.equal(left.trim(), '0', 'the timeout killed the script');
  });
});
