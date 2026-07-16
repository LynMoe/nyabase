import { describe, expect, it } from 'vitest';
import { api, containerAction, createContainerRunning, removeContainerViaTask, loadActor, loadState, rawApi, waitActionEnabled } from './v2-live-helpers.js';


describe('V2 beta persona live flow', () => {
  it('creates a beta container and waits for each durable Agent task', async () => {
    const state = await loadState();
    const beta = await loadActor(state, 'beta');
    const c = await createContainerRunning(state, beta.token, { serverId: state.servers.cpu.id, imageId: state.images.cpuB!.id, name: `${state.runPrefix}-beta-v2`, cpuMillis: 100, memBytes: 64 * 1024 * 1024 });
    await waitActionEnabled(state, beta.token, c.id, 'stats');
    expect((await api(state, 'GET', `/v2/containers/${c.id}/stats`, beta.token)).status).toBe(200);
    await containerAction(state, beta.token, c.id, 'stop');
    await containerAction(state, beta.token, c.id, 'start');
    await removeContainerViaTask(state, beta.token, c.id);
  }, 180_000);
});
