import { describe, expect, it } from 'vitest';
import { api, containerAction, createContainerRunning, removeContainerViaTask, loadActor, loadState, rawApi, waitActionEnabled } from './v2-live-helpers.js';


describe('V2 alpha persona live flow', () => {
  it('creates a running CPU container, exercises stats and lifecycle tasks, and denies GPU', async () => {
    const state = await loadState();
    const alpha = await loadActor(state, 'alpha');
    const name = `${state.runPrefix}-alpha-v2`;
    const c = await createContainerRunning(state, alpha.token, { serverId: state.servers.cpu.id, imageId: state.images.cpuA!.id, name, cpuMillis: 100, memBytes: 64 * 1024 * 1024 });
    expect(c.name).toBe(name);
    await waitActionEnabled(state, alpha.token, c.id, 'stats');
    expect((await api(state, 'GET', `/v2/containers/${c.id}/stats`, alpha.token)).status).toBe(200);
    await containerAction(state, alpha.token, c.id, 'stop');
    await waitActionEnabled(state, alpha.token, c.id, 'start');
    await containerAction(state, alpha.token, c.id, 'start');
    await waitActionEnabled(state, alpha.token, c.id, 'restart');
    await containerAction(state, alpha.token, c.id, 'restart');
    if (state.servers.gpu && state.images.gpuA) {
      const denied = await rawApi(state, 'POST', '/v2/containers', alpha.token, { serverId: state.servers.gpu.id, imageId: state.images.gpuA.id, name: `${state.runPrefix}-alpha-deny-gpu`, gpuIndices: [0] });
      expect([403, 404]).toContain(denied.status);
    }
    await removeContainerViaTask(state, alpha.token, c.id);
  }, 180_000);
});
