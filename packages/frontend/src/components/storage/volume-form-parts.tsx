import type { ComponentProps } from 'react';
import { Button } from '../ui/button.js';
import { DialogFooter } from '../ui/dialog.js';
import { SizeField } from '../ui/size-slider.js';
import { QuotaLine, overQuotaMessage, type QuotaLineQuota } from '../quota/quota-line.js';

type SizeFieldProps = ComponentProps<typeof SizeField>;

/**
 * The size input of a new volume: a slider bounded by the remaining quota,
 * and the remaining-quota line once a placement is chosen.
 */
export function CreateSizeField({
  id,
  value,
  onChange,
  limits,
  quota,
  over,
  showQuota,
  quotaTestId,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  limits: { scale: SizeFieldProps['scale']; availableGib: SizeFieldProps['availableGib'] };
  quota: QuotaLineQuota;
  over: boolean;
  showQuota: boolean;
  quotaTestId: string;
}) {
  return (
    <SizeField
      id={id}
      label="大小"
      value={value}
      onChange={onChange}
      scale={limits.scale}
      availableGib={limits.availableGib}
      invalid={over}
      error={over ? overQuotaMessage(quota) : undefined}
    >
      {showQuota ? <QuotaLine quota={quota} over={over} testId={quotaTestId} /> : null}
    </SizeField>
  );
}

/** Cancel and submit for a volume form; `blockedReason` explains a disabled submit. */
export function VolumeFormFooter({
  onCancel,
  onSubmit,
  disabled,
  blockedReason,
  label,
}: {
  onCancel: () => void;
  onSubmit: () => void;
  disabled: boolean;
  blockedReason: string | undefined;
  label: string;
}) {
  return (
    <DialogFooter>
      <Button variant="outline" onClick={onCancel}>取消</Button>
      <Button onClick={onSubmit} disabled={disabled} title={blockedReason}>{label}</Button>
    </DialogFooter>
  );
}

/** The form's one error line: a submit error, the size floor, or why the quota blocks it. */
export function VolumeFormError({ message, testId }: { message: string | null | undefined; testId?: string }) {
  if (!message) return null;
  return <p className="text-sm text-destructive" data-testid={testId}>{message}</p>;
}
