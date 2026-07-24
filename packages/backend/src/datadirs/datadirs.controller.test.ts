import { UserStatus } from '@nyabase/common';
import { describe, expect, it, vi } from 'vitest';
import { DataDirsController } from './datadirs.controller.js';

describe('DataDirsController ordinary-user projection', () => {
  it('lists only while a current active-user server grant owns the read lease', async () => {
    const dataDirsService = {
      listUserDirs: vi.fn().mockResolvedValue([{ id: 'dir-a', name: 'work' }]),
    };
    const accessResolver = {
      runWithActiveServerAccess: vi.fn(async (
        _userId: string,
        _serverId: string,
        work: () => Promise<unknown>,
      ) => work()),
    };
    const controller = new DataDirsController(dataDirsService as never, accessResolver as never);

    await expect(controller.list(
      { id: 'user-a' } as never,
      'server-a',
      'ignored-user',
    )).resolves.toEqual([{ id: 'dir-a', name: 'work' }]);
    expect(accessResolver.runWithActiveServerAccess).toHaveBeenCalledWith(
      'user-a',
      'server-a',
      expect.any(Function),
    );
    expect(dataDirsService.listUserDirs).toHaveBeenCalledWith('user-a', 'server-a');
  });

  it('never returns an Agent host path from create', async () => {
    const dataDirsService = {
      createDir: vi.fn().mockResolvedValue({
        id: 'dir-a',
        resourceId: 'dir-a',
        serverId: 'server-a',
        sourceKind: 'local',
        sourceId: 'disk-a',
        name: 'work',
        hostPath: '/srv/private/.nyabase/dirs/dir-a/data',
        taskId: 'task-a',
      }),
    };
    const accessResolver = { hasMountSourceAccess: vi.fn().mockResolvedValue(true) };
    const controller = new DataDirsController(dataDirsService as never, accessResolver as never);
    const user = { id: 'user-a', status: UserStatus.Active };

    const result = await controller.create(user as never, {
      serverId: 'server-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      name: 'work',
    });

    expect(result).toEqual({
      id: 'dir-a',
      resourceId: 'dir-a',
      serverId: 'server-a',
      sourceKind: 'local',
      sourceId: 'disk-a',
      name: 'work',
      taskId: 'task-a',
    });
    expect(result).not.toHaveProperty('hostPath');
  });
});
