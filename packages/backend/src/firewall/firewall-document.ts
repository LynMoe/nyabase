import { createHash } from 'node:crypto';
import {
  firewallDigestInput,
  type FirewallDocument,
  type FirewallPortRange,
  type FirewallRuleSpec,
} from '@nyabase/common';
import type { FirewallServerRuleRow } from './firewall.repository.js';

/** jsonb columns come back parsed from pg, but tolerate a string. */
export function jsonArray<T>(value: T[] | string | null | undefined): T[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || value.length === 0) return [];
  const parsed = JSON.parse(value) as unknown;
  return Array.isArray(parsed) ? parsed as T[] : [];
}

export function firewallDocument(rules: readonly FirewallRuleSpec[]): FirewallDocument {
  return {
    digest: createHash('sha256').update(firewallDigestInput(rules), 'utf8').digest('hex'),
    rules: rules.map((rule) => ({
      action: rule.action,
      protocol: rule.protocol,
      cidrs: [...rule.cidrs],
      ports: rule.ports.map((range) => ({ from: range.from, to: range.to })),
    })),
  };
}

/**
 * The document of each of `serverIds`, from its associations in priority
 * order (as the repository lists them). A server without rules gets the
 * empty document: it still has to be confirmed to lift the agent's
 * fail-closed table.
 */
export function firewallDocuments(
  serverIds: readonly string[],
  rows: readonly FirewallServerRuleRow[],
): Map<string, { document: FirewallDocument; ruleCount: number }> {
  const specs = new Map<string, Array<FirewallRuleSpec & { priority: number }>>();
  for (const serverId of serverIds) specs.set(serverId, []);
  for (const row of rows) {
    specs.get(row.server_id)?.push({
      priority: row.priority,
      action: row.action,
      protocol: row.protocol,
      cidrs: jsonArray<string>(row.cidrs),
      ports: jsonArray<FirewallPortRange>(row.ports),
    });
  }
  const documents = new Map<string, { document: FirewallDocument; ruleCount: number }>();
  for (const [serverId, rules] of specs) {
    rules.sort((left, right) => left.priority - right.priority);
    documents.set(serverId, { document: firewallDocument(rules), ruleCount: rules.length });
  }
  return documents;
}
