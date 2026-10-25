import * as React from 'react';
import { Input } from './input.js';
import { Label } from './label.js';
import { cn } from '../../lib/utils.js';
import {
  type SizeScale,
  clampToAvailable,
  formatSizeValue,
  formatTickLabel,
  gibInputText,
  labelIndices,
  positionOf,
  stepStop,
} from '../../lib/size-ladder.js';

/** Half the thumb width: the visual track is inset by it so it lines up with the native thumb. */
const THUMB_HALF = '0.5rem';
/** Room one tick label needs, in px; closer majors drop their label. */
const LABEL_PX = 34;
const UNAVAILABLE_PATTERN =
  'repeating-linear-gradient(135deg, hsl(var(--muted-foreground) / 0.35) 0 2px, transparent 2px 6px)';

const KEY_STEPS: Record<string, { direction: 1 | -1; count: number }> = {
  ArrowRight: { direction: 1, count: 1 },
  ArrowUp: { direction: 1, count: 1 },
  ArrowLeft: { direction: -1, count: 1 },
  ArrowDown: { direction: -1, count: 1 },
  PageUp: { direction: 1, count: 3 },
  PageDown: { direction: -1, count: 3 },
  End: { direction: 1, count: Number.MAX_SAFE_INTEGER },
  Home: { direction: -1, count: Number.MAX_SAFE_INTEGER },
};

/** Parses the GiB text of a size field; null unless it is a positive number. */
export function parsePositiveGib(text: string): number | null {
  const value = Number(text);
  return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
}

/** Track offset of a fraction (0–1) of the inset track, for absolutely positioned layers. */
function trackOffset(fraction: number): string {
  return `calc(${THUMB_HALF} + (100% - 2 * ${THUMB_HALF}) * ${fraction})`;
}

function useWidth(ref: React.RefObject<HTMLElement | null>, fallback: number): number {
  const [width, setWidth] = React.useState(fallback);
  React.useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface SizeSliderProps {
  /** Selected size in GiB; null when the text field holds no valid size. */
  valueGib: number | null;
  onChange: (gib: number) => void;
  scale: SizeScale;
  /** What is left (GiB); above it the track is hatched and the slider stops. null = no limit. */
  availableGib?: number | null;
  disabled?: boolean;
  labelledBy?: string;
  className?: string;
}

/**
 * A slider over the stops of a non-linear size scale. The native range input
 * (invisible, over the track) provides pointer, touch and a11y; keys step to
 * the neighbouring stop even from a typed value between stops.
 */
export function SizeSlider({
  valueGib,
  onChange,
  scale,
  availableGib = null,
  disabled = false,
  labelledBy,
  className,
}: SizeSliderProps) {
  const { stops } = scale;
  const last = stops.length - 1;
  const ticksRef = React.useRef<HTMLDivElement>(null);
  const width = useWidth(ticksRef, 320);
  const fraction = last > 0 && valueGib !== null ? positionOf(stops, valueGib) / last : 0;
  const availableFraction = availableGib !== null && last > 0 && availableGib < stops[last]!
    ? positionOf(stops, Math.max(0, availableGib)) / last
    : null;
  const labelled = new Set(labelIndices(scale, (LABEL_PX * last) / Math.max(width, 1)));

  const choose = (gib: number) => onChange(clampToAvailable(gib, availableGib));
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const step = KEY_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    choose(stepStop(stops, valueGib ?? stops[0]!, step.direction, step.count));
  };

  return (
    <div className={cn('min-w-0', disabled && 'opacity-50', className)}>
      <div className="relative h-5">
        <div
          className="absolute top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-secondary"
          style={{ left: THUMB_HALF, right: THUMB_HALF }}
        >
          <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${fraction * 100}%` }} />
          {availableFraction !== null ? (
            <div
              className="absolute inset-y-0 right-0 bg-muted"
              style={{ left: `${availableFraction * 100}%`, backgroundImage: UNAVAILABLE_PATTERN }}
              data-testid="size-slider-unavailable"
              title="超出剩余额度"
            />
          ) : null}
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(last, 0)}
          step={1}
          value={Math.round(fraction * last)}
          disabled={disabled}
          aria-labelledby={labelledBy}
          aria-valuetext={valueGib === null ? '未选择' : formatSizeValue(valueGib)}
          onChange={(event) => {
            const stop = stops[Number(event.target.value)];
            if (stop !== undefined) choose(stop);
          }}
          onKeyDown={onKeyDown}
          className={cn(
            'peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 disabled:cursor-not-allowed',
            '[&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none',
            '[&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:border-0',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background shadow transition-shadow',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-background',
            valueGib === null && 'border-muted-foreground',
          )}
          style={{ left: trackOffset(fraction) }}
        />
      </div>
      <div ref={ticksRef} className="relative h-5" style={{ marginLeft: THUMB_HALF, marginRight: THUMB_HALF }} aria-hidden>
        {stops.map((stop, index) => {
          const left = `${last > 0 ? (index / last) * 100 : 0}%`;
          const major = labelled.has(index);
          return (
            <React.Fragment key={stop}>
              <span
                className={cn('absolute top-0 w-px', major ? 'h-1.5 bg-muted-foreground/60' : 'h-1 bg-border')}
                style={{ left }}
              />
              {major ? (
                <span
                  className="absolute top-1.5 whitespace-nowrap text-[10px] leading-4 text-muted-foreground tabular-nums"
                  style={{
                    left,
                    transform: index === 0
                      ? `translateX(-${THUMB_HALF})`
                      : index === last ? `translateX(calc(-100% + ${THUMB_HALF}))` : 'translateX(-50%)',
                  }}
                >
                  {formatTickLabel(stop)}
                </span>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

export interface SizeFieldProps {
  /** Id of the GiB text input; the label points at it. */
  id: string;
  label: string;
  /** The GiB text, shared by the slider and the text input. */
  value: string;
  onChange: (text: string) => void;
  scale: SizeScale;
  availableGib?: number | null;
  disabled?: boolean;
  /** Marks the selected value as a problem (over quota). */
  invalid?: boolean;
  error?: string | null;
  /** The quota line under the slider. */
  children?: React.ReactNode;
}

/**
 * Size picker: label with the selected value on the right, a {@link SizeSlider}
 * with a GiB field for exact sizes (typed values may fall between stops), then
 * the quota line and any error.
 */
export function SizeField({
  id,
  label,
  value,
  onChange,
  scale,
  availableGib = null,
  disabled = false,
  invalid = false,
  error,
  children,
}: SizeFieldProps) {
  const labelId = `${id}-label`;
  const valueGib = parsePositiveGib(value);
  const flagged = invalid || Boolean(error);
  return (
    <div className="space-y-1.5" data-testid={`${id}-field`}>
      <div className="flex items-baseline justify-between gap-2">
        <Label id={labelId} htmlFor={id}>{label}</Label>
        <span
          className={cn('text-sm font-semibold tabular-nums', flagged && 'text-destructive')}
          data-testid={`${id}-value`}
        >
          {valueGib === null ? '—' : formatSizeValue(valueGib)}
        </span>
      </div>
      <div className="flex items-start gap-3">
        <SizeSlider
          className="flex-1 pt-2"
          valueGib={valueGib}
          onChange={(gib) => onChange(gibInputText(gib))}
          scale={scale}
          availableGib={availableGib}
          disabled={disabled}
          labelledBy={labelId}
        />
        <div className="relative w-24 shrink-0 sm:w-28">
          <Input
            id={id}
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={value}
            disabled={disabled}
            aria-label={`${label}（GiB）`}
            aria-invalid={flagged ? true : undefined}
            className="pr-11 text-right tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            onChange={(event) => onChange(event.target.value)}
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            GiB
          </span>
        </div>
      </div>
      {children}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
