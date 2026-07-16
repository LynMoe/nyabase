import { describe, expect, it } from 'vitest';
import { api, containerAction, createContainerRunning, removeContainerViaTask, loadActor, loadState, rawApi, waitActionEnabled } from './v2-live-helpers.js';


describe('V2 gamma/delta isolation live flow', () => {
  it('prevents delta from mutating gamma container by containerId-only route', async () => {
    const state = await loadState();
    if (!state.servers.gpu || !state.images.gpuA) return;
    const gamma = await loadActor(state, 'gamma');
    const delta = await loadActor(state, 'delta');
    let target;
    try {
      target = await createContainerRunning(state, gamma.token, { serverId: state.servers.gpu.id, imageId: state.images.gpuA.id, name: `${state.runPrefix}-gamma-target-v2`, cpuMillis: 100, memBytes: 128 * 1024 * 1024, gpuIndices: [0] });
    } catch (error) {
      if (String(error).includes('Address already in use')) return;
      throw error;
    }
    for (const suffix of ['', '/stats', '/actions/stop', '/actions/delete']) {
      const method = suffix.includes('/actions/') ? 'POST' : 'GET';
      const res = await rawApi(state, method, `/v2/containers/${target.id}${suffix}`, delta.token);
      expect([403, 404]).toContain(res.status);
    }
    await removeContainerViaTask(state, gamma.token, target.id);
  }, 180_000);
});
