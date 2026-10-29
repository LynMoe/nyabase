import { useEffect, useState } from 'react';
import { type SizeScale, gibInputText, maxDefault } from '../lib/size-ladder.js';

/**
 * Keeps an untouched size field at the most a create form can choose: the
 * range max within what is left (`maxDefault`), following the quota as it
 * loads. Once the user moves the slider or types (`markTouched`), the field is
 * theirs and is left alone.
 */
export function useFittedDefaultSize({
  enabled,
  fallbackGib,
  minGib = 0,
  scale,
  availableGib,
  setText,
}: {
  enabled: boolean;
  /** The default while the range has no real bound (unlimited or still loading). */
  fallbackGib: number;
  /** Never fitted below this (a hard floor, even when less is left). */
  minGib?: number;
  scale: SizeScale;
  availableGib: number | null;
  /** Must be stable (a state setter or a memoised callback). */
  setText: (text: string) => void;
}): { markTouched: () => void } {
  const [touched, setTouched] = useState(false);
  const next = gibInputText(Math.max(minGib, maxDefault(scale, fallbackGib, availableGib)));
  useEffect(() => {
    if (enabled && !touched) setText(next);
  }, [enabled, touched, next, setText]);
  return { markTouched: () => setTouched(true) };
}
