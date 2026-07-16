import { describe, expect, it } from 'vitest';
import { api, containerAction, createContainerRunning, removeContainerViaTask, loadActor, loadState, rawApi, waitActionEnabled } from './v2-live-helpers.js';


describe('V2 delta persona live flow', () => {
  it('creates CPU and optional GPU containers, then deletes through Agent tasks', async () => {
    const state = await loadState();
    const delta = await loadActor(state, 'delta');
    const cpu = await createContainerRunning(state, delta.token, { serverId: state.servers.cpu.id, imageId: state.images.cpuA!.id, name: `${state.runPrefix}-delta-cpu-v2`, cpuMillis: 100, memBytes: 64 * 1024 * 1024 });
    await waitActionEnabled(state, delta.token, cpu.id, 'stats');
    await removeContainerViaTask(state, delta.token, cpu.id);
    if (state.servers.gpu && state.images.gpuA) {
      const gpu = await createContainerRunning(state, delta.token, { serverId: state.servers.gpu.id, imageId: state.images.gpuA.id, name: `${state.runPrefix}-delta-gpu-v2`, cpuMillis: 100, memBytes: 128 * 1024 * 1024, gpuIndices: [1] });
      await removeContainerViaTask(state, delta.token, gpu.id);
    }
  }, 240_000);
});
