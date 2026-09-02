import type { ServerCardUiArea } from '@nyabase/common';
import { renderExtensionSlots } from './registry.js';
import type { SlotContextMap } from './types.js';

export function ExtensionSlots<A extends ServerCardUiArea>({
  area,
  ctx,
}: {
  area: A;
  ctx: SlotContextMap[A];
}) {
  const nodes = renderExtensionSlots(area, ctx);
  return (
    <>
      {nodes.map((item) => (
        <div key={item.id}>{item.node}</div>
      ))}
    </>
  );
}
