import { Injectable } from '@nestjs/common';
import {
  type AgentTaskKind,
  type TaskExecutePayload,
} from '@nyabase/common';
import { AgentTaskPayloadCodecService } from './agent-task-payload-codec.service.js';
import {
  validateDurableAgentTaskIdentity,
} from './agent-task-durable-contract.js';
import { WorkflowFinalizerRegistry } from './workflow-finalizer.registry.js';
import {
  WorkflowRepository,
  type DispatchClaim,
} from './workflow.repository.js';

export interface WorkflowDispatch {
  claim: DispatchClaim;
  payload: TaskExecutePayload;
}

export interface WorkflowAgentSessionBinding {
  id: string;
  generation: number;
  gatewayId: string;
}

@Injectable()
export class WorkflowDispatchService {
  private readonly workerId = `workflow-dispatch:${process.pid}`;

  constructor(
    private readonly repository: WorkflowRepository,
    private readonly payloadCodec: AgentTaskPayloadCodecService,
    private readonly finalizers: WorkflowFinalizerRegistry,
  ) {}

  async claimAndBuild(
    serverId: string,
    session?: WorkflowAgentSessionBinding,
  ): Promise<WorkflowDispatch | null> {
    if (!session) return null;
    const claim = await this.repository.claimNextDispatch(
      serverId,
      this.workerId,
      {
        allowedKinds: this.finalizers.supportedKinds(),
        agentSession: session,
      },
    );
    if (!claim) return null;
    try {
      const identity = {
        id: claim.task.id,
        kind: claim.task.kind as AgentTaskKind,
        serverId: claim.task.serverId,
        resourceType: claim.task.resourceType,
        resourceId: claim.task.resourceId,
        payloadHash: claim.task.payloadHash,
      };
      const wirePayload = validateDurableAgentTaskIdentity(
        identity,
        this.payloadCodec.forWirePayload(
          identity.kind,
          claim.task.payload,
        ),
      );
      return {
        claim,
        payload: {
          taskId: claim.task.id,
          kind: identity.kind,
          payloadHash: claim.task.payloadHash,
          payload: wirePayload,
        },
      };
    } catch (error) {
      await this.repository.failNeverSentDispatchClaim(
        claim.task.id,
        claim.generation,
        claim.claimToken,
        error,
      );
      throw error;
    }
  }

  markSent(dispatch: WorkflowDispatch): Promise<boolean> {
    return this.repository.markDispatchSent(
      dispatch.claim.task.id,
      dispatch.claim.claimToken,
      {
        id: dispatch.claim.agentSessionId,
        generation: dispatch.claim.agentSessionGeneration,
        gatewayId: dispatch.claim.gatewayId,
      },
    );
  }

  markSentAndSend(
    dispatch: WorkflowDispatch,
    send: () => boolean,
  ): Promise<boolean> {
    return this.repository.markDispatchSentAndSend(
      dispatch.claim.task.id,
      dispatch.claim.claimToken,
      {
        serverId: dispatch.claim.task.serverId,
        id: dispatch.claim.agentSessionId,
        generation: dispatch.claim.agentSessionGeneration,
        gatewayId: dispatch.claim.gatewayId,
      },
      send,
    );
  }
}
