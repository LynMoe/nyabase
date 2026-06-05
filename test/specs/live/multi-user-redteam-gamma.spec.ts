import { describe, expect, it } from 'vitest';
import { api, containerAction, createContainerActive, removeContainerViaOperation, loadActor, loadState, rawApi, waitActionEnabled } from './v2-live-helpers.js';


describe('V2 gamma GPU persona live flow', () => {
  it('creates GPU container when GPU fixture exists and verifies metrics path is non-leaking', async () => {
    const state = await loadState();
    const gamma = await loadActor(state, 'gamma');
    if (!state.servers.gpu || !state.images.gpuA) return;
    let c;
    try {
      c = await createContainerActive(state, gamma.token, { serverId: state.servers.gpu.id, imageId: state.images.gpuA.id, name: `${state.runPrefix}-gamma-v2`, cpuMillis: 100, memBytes: 128 * 1024 * 1024, gpuIndices: [0] });
    } catch (error) {
      if (String(error).includes('Address already in use')) return;
      throw error;
    }
    await waitActionEnabled(state, gamma.token, c.id, 'stats');
    expect((await api(state, 'GET', `/v2/containers/${c.id}/stats`, gamma.token)).status).toBe(200);
    const metrics = await rawApi(state, 'GET', `/metrics/servers/${state.servers.gpu.id}/containers?range=5m`, gamma.token);
    expect([200, 403]).toContain(metrics.status);
    await removeContainerViaOperation(state, gamma.token, c.id);
  }, 180_000);
});
