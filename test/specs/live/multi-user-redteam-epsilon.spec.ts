import { describe, expect, it } from 'vitest';
import { loadActor, loadState, rawApi } from './v2-live-helpers.js';


describe('V2 epsilon no-access live flow', () => {
  it('denies unauthorised container and admin surfaces', async () => {
    const state = await loadState();
    const epsilon = await loadActor(state, 'epsilon');
    expect((await rawApi(state, 'GET', '/v2/containers', epsilon.token)).status).toBe(200);
    const create = await rawApi(state, 'POST', '/v2/containers', epsilon.token, { serverId: state.servers.cpu.id, imageId: state.images.cpuA!.id, name: `${state.runPrefix}-epsilon-deny` });
    expect([403, 404]).toContain(create.status);
    expect((await rawApi(state, 'GET', '/admin/users', epsilon.token)).status).toBe(403);
  }, 60_000);
});
