import type { GrantBundleField, GrantExpiryPhase } from '@nyabase/common';
import { grantExpiryPhaseLabel } from '../../lib/display-labels.js';
import {
  GRANT_BUNDLE_FIELDS,
  GRANT_FIELD_INPUT_LABELS,
  GRANT_FIELD_LABELS,
  type KnownQuotas,
  type OverrideDraft,
  type QuotaTexts,
  formatQuotaValue,
  parseQuotaText,
  quotaTextError,
  quotaToText,
  toggleOverride,
} from '../../lib/grant-bundle-form.js';
import { approxGibHint } from '../../lib/utils.js';
import { FormField } from '../layout/form-field.js';
import { Badge } from '../ui/badge.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Switch } from '../ui/switch.js';
import { defaultExpiryLocal, expirySummary } from './use-grant-panel-data.js';

export function PhaseBadge({ phase }: { phase: GrantExpiryPhase }) {
  return (
    <Badge variant={phase === 'lost' ? 'destructive' : phase === 'grace' ? 'warning' : 'outline'}>
      {grantExpiryPhaseLabel(phase)}
    </Badge>
  );
}

/** 有效期: 永久 unless switched on, then a local date-time. */
export function GrantExpiryInput({ id, value, onChange }: { id: string; value: string; onChange: (value: string) => void }) {
  const enabled = value.length > 0;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
        <div className="min-w-0">
          <p className="text-sm font-medium">有效期</p>
          <p className="text-xs text-muted-foreground">{enabled ? `至 ${expirySummary(value)}` : '永久'}</p>
        </div>
        <Switch
          id={id}
          checked={enabled}
          onCheckedChange={(checked) => onChange(checked ? defaultExpiryLocal() : '')}
          aria-label="设置到期时间"
        />
      </div>
      {enabled && (
        <FormField id={`${id}-at`} label="到期时间（本地时区）">
          <Input
            id={`${id}-at`}
            type="datetime-local"
            value={value}
            onChange={(event) => onChange(event.target.value)}
          />
        </FormField>
      )}
    </div>
  );
}

export function NumberField({
  id,
  label,
  value,
  onChange,
  hint,
  error,
  step = 'any',
  disabled = false,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  step?: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  return (
    <FormField id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        type="number"
        min="0"
        step={step}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

function quotaHint(field: GrantBundleField, text: string): string | undefined {
  if (field !== 'memBytes' && field !== 'rootDiskBytes') return undefined;
  const bytes = parseQuotaText(field, text);
  return typeof bytes === 'number' ? approxGibHint(bytes) : undefined;
}

const GPU_DISABLED_HINT = '该服务器未启用 GPU';

/** A GPU field on a server without GPU passthrough: nothing to grant, so it is fixed at 无. */
function gpuLocked(field: GrantBundleField, gpuEnabled: boolean | undefined): boolean {
  return field === 'gpuCount' && gpuEnabled === false;
}

function placeholderFor(field: GrantBundleField, locked: boolean): string {
  if (field !== 'gpuCount') return '不限';
  return locked ? '无' : '全部';
}

function QuotaInput({
  id,
  field,
  value,
  onChange,
  locked = false,
}: {
  id: string;
  field: GrantBundleField;
  value: string;
  onChange: (value: string) => void;
  locked?: boolean;
}) {
  return (
    <NumberField
      id={id}
      label={GRANT_FIELD_INPUT_LABELS[field]}
      value={value}
      onChange={onChange}
      step={field === 'memBytes' || field === 'rootDiskBytes' ? 'any' : '1'}
      placeholder={placeholderFor(field, locked)}
      disabled={locked}
      hint={locked ? GPU_DISABLED_HINT : quotaHint(field, value)}
      error={locked ? null : quotaTextError(field, value)}
    />
  );
}

/**
 * The four quotas of a bundle, every one editable (empty = 不限). On a server
 * without GPU passthrough (`gpuEnabled: false`) the GPU field is fixed.
 */
export function BundleQuotaFields({
  idPrefix,
  texts,
  onChange,
  gpuEnabled,
}: {
  idPrefix: string;
  texts: QuotaTexts;
  onChange: (texts: QuotaTexts) => void;
  gpuEnabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {GRANT_BUNDLE_FIELDS.map((field) => (
        <QuotaInput
          key={field}
          id={`${idPrefix}-${field}`}
          field={field}
          value={texts[field]}
          locked={gpuLocked(field, gpuEnabled)}
          onChange={(value) => onChange({ ...texts, [field]: value })}
        />
      ))}
    </div>
  );
}

/**
 * The four quotas of a user's grant: fields with「修改」off follow the bundle
 * and show its value; switching it on enables the input for the user's own.
 * `bundle` fields may be unknown (undefined) while the bundle loads.
 */
export function OverrideQuotaFields({
  idPrefix,
  bundle,
  draft,
  onChange,
  gpuEnabled,
}: {
  idPrefix: string;
  bundle: KnownQuotas;
  draft: OverrideDraft;
  onChange: (draft: OverrideDraft) => void;
  gpuEnabled?: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2" data-testid={`${idPrefix}-quotas`}>
      {GRANT_BUNDLE_FIELDS.map((field) => {
        const locked = gpuLocked(field, gpuEnabled);
        const overridden = draft.overridden[field];
        const known = bundle[field];
        const inputId = `${idPrefix}-${field}`;
        const checkboxId = `${inputId}-override`;
        const text = overridden ? draft.texts[field] : known !== undefined && !locked ? quotaToText(field, known) : '';
        const error = overridden ? quotaTextError(field, text) : null;
        const hint = overridden ? quotaHint(field, text) : undefined;
        const bundleValue = known === undefined ? null : formatQuotaValue(field, known, { gpuEnabled });
        const note = locked
          ? GPU_DISABLED_HINT
          : overridden
            ? (bundleValue ? `模板 ${bundleValue}` : null)
            : (bundleValue ? '跟随模板' : '模板值加载中…');
        return (
          <div key={field} className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor={inputId}>{GRANT_FIELD_INPUT_LABELS[field]}</Label>
              <div className="flex shrink-0 items-center gap-1.5">
                <Label htmlFor={checkboxId} className="text-xs font-normal text-muted-foreground">修改</Label>
                <Switch
                  id={checkboxId}
                  checked={overridden}
                  // Switching on starts from the bundle's value, so it waits for it; switching off always works.
                  disabled={!overridden && (locked || known === undefined)}
                  onCheckedChange={(checked) => onChange(toggleOverride(draft, field, checked, bundle))}
                  aria-label={`修改${GRANT_FIELD_LABELS[field]}`}
                />
              </div>
            </div>
            <Input
              id={inputId}
              type="number"
              min="0"
              step={field === 'memBytes' || field === 'rootDiskBytes' ? 'any' : '1'}
              value={text}
              disabled={!overridden}
              placeholder={!overridden && known === undefined ? '' : placeholderFor(field, locked)}
              aria-invalid={error ? true : undefined}
              onChange={(event) => onChange({ ...draft, texts: { ...draft.texts, [field]: event.target.value } })}
            />
            {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        );
      })}
    </div>
  );
}
