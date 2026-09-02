import type { ExtensionErrorFormatter } from '@nyabase/common';
import type { ServerCardUiArea } from '@nyabase/common';
import { frontendExtensionHost } from './host.js';
import type { ServerCardWebExtension, SlotContextMap } from './types.js';

const extensions: ServerCardWebExtension[] = [];
const formatters: ExtensionErrorFormatter[] = [];

export function registerServerCardExtensions(next: readonly ServerCardWebExtension[]): void {
  extensions.splice(0, extensions.length, ...next);
}

export function registerExtensionErrorFormatters(next: readonly ExtensionErrorFormatter[]): void {
  formatters.splice(0, formatters.length, ...next);
}

export function registeredServerCardExtensions(): readonly ServerCardWebExtension[] {
  return extensions;
}

export function formatRegisteredExtensionError(code: string): string | undefined {
  for (const formatter of formatters) {
    const label = formatter(code);
    if (label) return label;
  }
  return undefined;
}

export function renderExtensionSlots<A extends ServerCardUiArea>(
  area: A,
  ctx: SlotContextMap[A],
) {
  return extensions.flatMap((ext) => {
    const Slot = ext.slots[area];
    if (!Slot) return [];
    return [{
      id: ext.id,
      node: Slot({ host: frontendExtensionHost, ctx: ctx as never }),
    }];
  });
}
