import { randomUUID } from 'node:crypto';
import type {
  WorkflowAgentSessionBinding,
} from './workflow-dispatch.service.js';
import type { WorkflowRepository } from './workflow.repository.js';

export async function createReadyAgentSession(
  repository: WorkflowRepository,
  serverId: string,
): Promise<WorkflowAgentSessionBinding> {
  const id = randomUUID();
  const gatewayId = `gateway:test:${id}`;
  const admitted = await repository.admitAgentSession({
    id,
    serverId,
    sessionToken: `token:${id}`,
    hostFingerprint: `host:${id}`,
    configFingerprint: `config:${id}`,
    gatewayId,
    consolePublicUrl: 'wss://gateway.test/ws/console',
  });
  const ready = await repository.markAgentSessionReady(
    serverId,
    id,
    admitted.generation,
    gatewayId,
  );
  if (!ready) {
    throw new Error(`Failed to ready Agent session ${id} for Server ${serverId}`);
  }
  return {
    id,
    generation: admitted.generation,
    gatewayId,
  };
}
