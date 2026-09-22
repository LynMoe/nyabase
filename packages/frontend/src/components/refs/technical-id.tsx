import type { MouseEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';
import { opaquePreview, shortFingerprint } from './truncate-id.js';

export function foldedTechnicalText(options: {
  value: string;
  kind: 'opaque' | 'fingerprint';
  alias?: string | null;
  visible?: string;
}): string {
  if (options.visible !== undefined) return options.visible;
  if (options.kind === 'fingerprint') {
    const short = shortFingerprint(options.value);
    const alias = options.alias?.trim();
    return alias ? `${alias} ${short}` : short;
  }
  return opaquePreview(options.value);
}

/**
 * Secondary technical identifier. The short form stays on the page; hovering
 * the dashed text shows the full value in a tooltip.
 */
export function TechnicalId({
  label,
  value,
  kind = 'opaque',
  alias,
  visible,
  className,
}: {
  /** Field name for the accessible name. The component does not render a caption. */
  label: string;
  /** Full raw value. Callers render their own empty state instead of passing null. */
  value: string;
  kind?: 'opaque' | 'fingerprint';
  /** Catalog alias for kind="fingerprint". Omit rather than inventing a name. */
  alias?: string | null;
  /** Replaces the folded text. Public-key previews pass the existing preview. */
  visible?: string;
  /** Replaces the default field-value treatment when the folded text is a human label. */
  className?: string;
}) {
  const folded = foldedTechnicalText({ value, kind, alias, visible });
  const hinted = folded !== value;
  const tone = className ?? 'inline max-w-full truncate text-sm text-foreground';

  if (!hinted) {
    return <span className={tone}>{value}</span>;
  }

  function keepRowClick(event: MouseEvent<HTMLSpanElement>) {
    event.stopPropagation();
  }

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              tone,
              'cursor-help bg-[linear-gradient(to_right,currentColor_2px,transparent_2px)] bg-[length:4px_1px] bg-left-bottom bg-repeat-x text-foreground',
            )}
            aria-label={`${label} ${value}`}
            onClick={keepRowClick}
          >
            {folded}
          </span>
        </TooltipTrigger>
        <TooltipContent className="break-all">{value}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
