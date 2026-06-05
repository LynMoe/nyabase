import { describe, expect, it } from 'vitest';
import { api, containerAction, createContainerActive, removeContainerViaOperation, loadActor, loadState, rawApi, waitActionEnabled } from './v2-live-helpers.js';


describe('V2 continuation live flow', () => {
  it('continues after setup with operation/action based lifecycle', async () => {
    const state = await loadState();
    const alpha = await loadActor(state, 'alpha');
    const c = await createContainerActive(state, alpha.token, { serverId: state.servers.cpu.id, imageId: state.images.cpuA!.id, name: `${state.runPrefix}-continuation-v2`, cpuMillis: 100, memBytes: 64 * 1024 * 1024 });
    await waitActionEnabled(state, alpha.token, c.id, 'stats');
    await containerAction(state, alpha.token, c.id, 'restart');
    await removeContainerViaOperation(state, alpha.token, c.id);
  }, 180_000);
});
