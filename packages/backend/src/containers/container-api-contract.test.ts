import { BadRequestException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import {
  FailureCode,
  ContainerPowerIntent,
  ContainerStatus,
  IntentResourceType,
  IntentStatus,
  type ErrorResponse,
  type IntentAcceptedDto,
  zErrorResponse,
  zCreateContainerRequest,
  zIntentAcceptedDto,
} from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  AdminContainersController,
} from './admin-containers.controller.js';
import { ContainersController } from './containers.controller.js';
import {
  AdminContainerIntentsController,
  ContainerIntentsController,
} from '../runtime/intents.controller.js';
import {
  assertContainerName,
  containerStatus,
  normalizeGpuAddresses,
} from './container-control.service.js';

describe('container API contract', () => {
  it('accepts only the clean-cutover create payload', () => {
    const valid = {
      serverId: 'server-a',
      imageId: 'image-a',
      name: 'demo',
      rootSizeBytes: 1_073_741_824,
      cpuMillis: 500,
      memBytes: 536_870_912,
      gpuPciAddresses: ['0000:01:00.0'],
      powerIntent: ContainerPowerIntent.Stopped,
    };
    expect(zCreateContainerRequest.parse(valid)).toMatchObject({
      ...valid,
      gpuPciAddresses: ['00000000:01:00.0'],
    });
    const legacyTaskField = ['task', 'Id'].join('');
    const legacyMountField = ['m', 'ounts'].join('');
    expect(zCreateContainerRequest.safeParse({
      ...valid,
      [legacyTaskField]: 'legacy-task',
    }).success).toBe(false);
    expect(zCreateContainerRequest.safeParse({
      ...valid,
      [legacyMountField]: [],
    }).success).toBe(false);
    for (const field of [['docker', 'Root'], ['mac', 'vlanIp']]) {
      expect(zCreateContainerRequest.safeParse({
        ...valid,
        [field.join('')]: 'legacy',
      }).success).toBe(false);
    }
  });

  it('normalizes and validates PCI assignments without compatibility fields', () => {
    expect(normalizeGpuAddresses(['0000:01:00.0', '00000000:02:00.7', '0000:0A:00.1']))
      .toEqual(['00000000:01:00.0', '00000000:02:00.7', '00000000:0a:00.1']);
    expect(() => normalizeGpuAddresses(['0000:01:00.0', '0000:01:00.0']))
      .toThrow(BadRequestException);
    expect(() => normalizeGpuAddresses(['0000:01:00.0', '00000000:01:00.0']))
      .toThrow(BadRequestException);
    expect(() => normalizeGpuAddresses(['01:00.0']))
      .toThrow(BadRequestException);
    expect(() => normalizeGpuAddresses(['0000:01:00.8']))
      .toThrow(BadRequestException);
    expect(() => normalizeGpuAddresses(['00000000:01:00.f']))
      .toThrow(BadRequestException);
    expect(() => assertContainerName('bad/name')).toThrow(BadRequestException);
  });

  it('does not treat legacy runtime states as Incus stopped states', () => {
    expect(containerStatus('Stopped', ContainerPowerIntent.Running)).toBe(ContainerStatus.Stopped);
    expect(containerStatus('Exited', ContainerPowerIntent.Stopped)).toBe(ContainerStatus.Unknown);
    expect(containerStatus(null, ContainerPowerIntent.Stopped)).toBe(ContainerStatus.Stopped);
  });

  it('exposes canonical user and admin routes', () => {
    const methodPath = (prototype: object, method: string) => {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
      return Reflect.getMetadata(PATH_METADATA, descriptor?.value);
    };
    const expected = {
      list: '/',
      create: '/',
      get: ':containerId',
      start: ':containerId/actions/start',
      stop: ':containerId/actions/stop',
      restart: ':containerId/actions/restart',
      repairSsh: ':containerId/actions/repair-ssh',
      delete: ':containerId/actions/delete',
      limits: ':containerId/limits',
      rootSize: ':containerId/root-size',
      gpu: ':containerId/gpu',
      volumes: ':containerId/volumes',
      stats: ':containerId/stats',
      execSession: ':containerId/exec-sessions',
    };
    for (const [method, path] of Object.entries(expected)) {
      expect(methodPath(ContainersController.prototype, method)).toBe(path);
      expect(methodPath(AdminContainersController.prototype, method)).toBe(path);
    }
    expect(Reflect.getMetadata(PATH_METADATA, ContainersController)).toBe('containers');
    expect(Reflect.getMetadata(PATH_METADATA, AdminContainersController)).toBe('admin/containers');
    expect(Reflect.getMetadata(PATH_METADATA, ContainerIntentsController))
      .toBe('containers/:containerId/intents');
    expect(Reflect.getMetadata(PATH_METADATA, AdminContainerIntentsController))
      .toBe('admin/containers/:containerId/intents');
    expect(methodPath(ContainerIntentsController.prototype, 'list')).toBe('/');
    expect(methodPath(AdminContainerIntentsController.prototype, 'list')).toBe('/');
    expect(Object.values(expected).some((path) => path.includes('/v2'))).toBe(false);
  });

  it('validates accepted-intent and structured-error DTOs without legacy fields', () => {
    const accepted: IntentAcceptedDto = {
      intentId: 'intent-1',
      resourceType: IntentResourceType.Container,
      resourceId: 'container-1',
      serverId: 'server-1',
      targetGeneration: 2,
      status: IntentStatus.Pending,
      createdAt: '2026-08-07T00:00:00.000Z',
    };
    expect(zIntentAcceptedDto.parse(accepted)).toEqual(accepted);

    const error: ErrorResponse = {
      statusCode: 409,
      code: FailureCode.GpuChangeRequiresStop,
      message: 'The container must be stopped before changing GPU devices.',
      requestId: 'request-1',
      details: { containerId: 'container-1' },
    };
    expect(zErrorResponse.parse(error)).toEqual(error);
    const legacyOperationField = ['task', 'Id'].join('');
    expect(zErrorResponse.safeParse({
      ...error,
      [legacyOperationField]: 'legacy',
    }).success).toBe(false);
  });
});
