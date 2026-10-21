import { Injectable } from '@nestjs/common';
import type { IntentRecord, IntentResource } from './intent.repository.js';
import type { ManagedReconciler, ServerHealthPort } from './managed-reconciler.js';

/**
 * Domain modules register their reconciler (and the servers module its
 * server-health port) in `onModuleInit`; the worker starts afterwards in
 * `onApplicationBootstrap`.
 */
@Injectable()
export class ReconcilerRegistry {
  private readonly reconcilers: ManagedReconciler[] = [];
  private health?: ServerHealthPort;

  register(reconciler: ManagedReconciler): void {
    if (this.reconcilers.some((existing) => existing.resourceType === reconciler.resourceType)) {
      throw new Error(`A reconciler is already registered for ${reconciler.resourceType}`);
    }
    this.reconcilers.push(reconciler);
  }

  registerServerHealth(port: ServerHealthPort): void {
    if (this.health) throw new Error('A server health port is already registered');
    this.health = port;
  }

  all(): readonly ManagedReconciler[] {
    return this.reconcilers;
  }

  forIntent(intent: IntentRecord): ManagedReconciler | undefined {
    return this.reconcilers.find((candidate) => candidate.supports(intent));
  }

  forResource(resourceType: IntentResource): ManagedReconciler | undefined {
    return this.reconcilers.find((candidate) => candidate.resourceType === resourceType);
  }

  serverHealth(): ServerHealthPort {
    if (!this.health) throw new Error('No server health port is registered');
    return this.health;
  }
}
