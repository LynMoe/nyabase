import type { MouseEvent } from 'react';
import { cn } from '../../lib/utils.js';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip.js';

/**
 * opaque: ids and hashes nobody reads, folded to 8 characters.
 * fingerprint: image or certificate hashes, folded to an alias plus 6 hex.
 * text: values people read and compare (slugs, URLs, paths, aliases); never folded,
 * wraps instead of overflowing.
 */
export type TechnicalIdKind = 'opaque' | 'fingerprint' | 'text';

export function foldedTechnicalText(options: {
  value: string;
  kind: TechnicalIdKind;
  alias?: string | null;
  visible?: string;
}): string {
  if (options.visible !== undefined) return options.visible;
  if (options.kind === 'text') return options.value;
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
  kind?: TechnicalIdKind;
  /** Catalog alias for kind="fingerprint". Omit rather than inventing a name. */
  alias?: string | null;
  /** Replaces the folded text. Public-key previews pass the existing preview. */
  visible?: string;
  /** Replaces the default field-value treatment when the folded text is a human label. */
  className?: string;
}) {
  const folded = foldedTechnicalText({ value, kind, alias, visible });
  const hinted = folded !== value;
  const tone = className ?? (kind === 'text'
    ? 'inline max-w-full text-sm text-foreground [overflow-wrap:anywhere]'
    : 'inline max-w-full truncate text-sm text-foreground');

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

export type ResourceKind =
  | 'user'
  | 'group'
  | 'server'
  | 'container'
  | 'volume'
  | 'shared-volume'
  | 'image'
  | 'pool'
  | 'shared-backend';

export type ResourceRefProps = {
  kind: ResourceKind;
  id: string;
  name?: string;
};

const DEFAULT_LENGTH = 8;

/** Truncate a resource id for fallback labels. UUIDs become the first 8 hex chars. */
export function truncateId(id: string, length = DEFAULT_LENGTH): string {
  if (id.length <= length) return id;
  return id.slice(0, length);
}

/** Image fingerprints are 64 hex chars. There is no API short id. */
export function shortFingerprint(fingerprint: string, length = 6): string {
  const body = fingerprint.trim().toLowerCase().replace(/^sha256:/, '');
  return body.slice(0, length);
}

/** Folded opaque text: full value when it already fits, otherwise the first 8 chars plus an ellipsis. */
export function opaquePreview(value: string, length = DEFAULT_LENGTH): string {
  if (value.length <= length) return value;
  return `${truncateId(value, length)}…`;
}
