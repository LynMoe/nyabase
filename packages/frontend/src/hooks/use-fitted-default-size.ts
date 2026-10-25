import { useEffect, useState } from 'react';
import { fitDefault, gibInputText } from '../lib/size-ladder.js';

/**
 * Keeps an untouched size field's default within what is left, so a create
 * form never opens already over quota. Once the user moves the slider or types
 * (`markTouched`), the field is theirs and is left alone.
 */
export function useFittedDefaultSize({
  enabled,
  defaultGib,
  stops,
  availableGib,
  setText,
}: {
  enabled: boolean;
  defaultGib: number;
  stops: readonly number[];
  availableGib: number | null;
  /** Must be stable (a state setter or a memoised callback). */
  setText: (text: string) => void;
}): { markTouched: () => void } {
  const [touched, setTouched] = useState(false);
  const next = gibInputText(fitDefault(stops, defaultGib, availableGib));
  useEffect(() => {
    if (enabled && !touched) setText(next);
  }, [enabled, touched, next, setText]);
  return { markTouched: () => setTouched(true) };
}
