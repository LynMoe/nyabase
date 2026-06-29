import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AgentCommandKind,
  CommandHookName,
  OperationKind,
} from '@nyabase/common';
import { Repository } from 'typeorm';
import { ContainerEntity } from '../entities/container.entity.js';
import { ImageEntity } from '../entities/image.entity.js';
import { AgentGateway } from '../gateway/agent-gateway.js';
import { ResourceKeyService } from '../operations/resource-key.service.js';
import { SshIdentityService } from '../ssh/ssh-identity.service.js';
import type { CommandHook, CommandHookContext } from './command-hook.types.js';
import {
  payloadRecord,
  runtimeIdFromResult,
  runtimeIdFromSnapshot,
} from './container-hook-utils.js';

const SSH_ENSURE_OPERATION_KINDS = new Set<OperationKind>([
  OperationKind.ContainerCreate,
  OperationKind.ContainerStart,
  OperationKind.ContainerRestart,
  OperationKind.ContainerUpdateMounts,
]);

@Injectable()
export class ContainerSshEnsureHook implements CommandHook {
  readonly name = CommandHookName.ContainerSshEnsure;

  constructor(
    @InjectRepository(ContainerEntity)
    private containersRepo: Repository<ContainerEntity>,
    @InjectRepository(ImageEntity)
    private imagesRepo: Repository<ImageEntity>,
    private resourceKeyService: ResourceKeyService,
    private agentGateway: AgentGateway,
    private sshIdentities: SshIdentityService,
  ) {}

  async appliesTo(context: CommandHookContext): Promise<boolean> {
    if (context.resourceType !== 'container') return false;
    if (!SSH_ENSURE_OPERATION_KINDS.has(context.operationKind)) return false;
    return true;
  }

  resourceKeys(context: CommandHookContext): string[] {
    return [this.resourceKeyService.container(context.resourceId)];
  }

  async buildCommand(context: CommandHookContext) {
    const runtimeId = runtimeIdFromResult(context.mainResult)
      ?? this.runtimeIdFromPayload(context.payload)
      ?? runtimeIdFromSnapshot(this.agentGateway.stateCache.getContainerByContainerId(context.serverId, context.resourceId));
    if (!runtimeId) return null;
    const container = await this.container(context);
    if (!container) return null;
    const image = await this.imagesRepo.findOneBy({ id: container.imageId });
    if (image?.disableSsh) {
      return {
        commandKind: AgentCommandKind.RuntimeContainerSshApply,
        payload: {
          runtimeId,
          enabled: false,
        },
      };
    }
    const internalKey = await this.sshIdentities.getUserInternalPublicKey(container.ownerId);
    return {
      commandKind: AgentCommandKind.RuntimeContainerSshApply,
      payload: {
        runtimeId,
        enabled: true,
        internalPublicKey: internalKey.publicKey,
        internalKeyGeneration: internalKey.generation,
      },
    };
  }

  async mergeResult(_context: CommandHookContext, _result: unknown): Promise<void> {
    return;
  }

  private runtimeIdFromPayload(payload: unknown): string | null {
    const value = payloadRecord(payload).runtimeId;
    return typeof value === 'string' && value.trim() !== '' ? value : null;
  }

  private async container(context: CommandHookContext): Promise<ContainerEntity | null> {
    return this.containersRepo.findOneBy({ id: context.resourceId });
  }
}
