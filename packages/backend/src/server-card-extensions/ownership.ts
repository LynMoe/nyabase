import { SERVER_CARD_EXTENSION_ID_RE } from '@nyabase/common';
import { CORE_MANAGED_FIELD_OWNERSHIP } from '../incus/compare-managed-fields.js';
import type { ServerCardExtension } from './types.js';

interface OwnedPrefix {
  readonly owner: string;
  readonly prefix: string;
}

function owned(owner: string, prefixes: readonly string[]): OwnedPrefix[] {
  return prefixes.map((prefix) => ({ owner, prefix }));
}

function assertPrefixSet(items: readonly OwnedPrefix[], kind: string): void {
  for (const item of items) {
    if (item.prefix.length === 0) {
      throw new Error(`server-card extension ${kind} prefix must not be empty (${item.owner})`);
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const left = items[i];
      const right = items[j];
      if (left.prefix.startsWith(right.prefix) || right.prefix.startsWith(left.prefix)) {
        throw new Error(
          `server-card extension ${kind} prefix collision: ` +
            `${left.owner}:${left.prefix} vs ${right.owner}:${right.prefix}`,
        );
      }
    }
  }
}

export function assertNoPrefixCollision(extensions: readonly ServerCardExtension[]): void {
  const seen = new Set<string>();
  for (const ext of extensions) {
    if (!SERVER_CARD_EXTENSION_ID_RE.test(ext.id)) {
      throw new Error(`invalid server-card extension id: ${ext.id}`);
    }
    if (seen.has(ext.id)) {
      throw new Error(`duplicate server-card extension id: ${ext.id}`);
    }
    seen.add(ext.id);
  }

  assertPrefixSet(
    [
      ...owned('core', CORE_MANAGED_FIELD_OWNERSHIP.configPrefixes),
      ...extensions.flatMap((ext) => owned(ext.id, ext.ownedIncusConfigKeyPrefixes)),
    ],
    'config',
  );
  assertPrefixSet(
    [
      ...owned('core', CORE_MANAGED_FIELD_OWNERSHIP.devicePrefixes),
      ...owned('core', CORE_MANAGED_FIELD_OWNERSHIP.deviceNames),
      ...extensions.flatMap((ext) => owned(ext.id, ext.ownedIncusDeviceNamePrefixes)),
    ],
    'device',
  );
}
