import * as React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';
import { FormField } from './form-field.js';

/** Labelled single-choice select over `[value, label]` pairs. */
export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  placeholder = '请选择',
  disabled = false,
  error,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  placeholder?: string;
  disabled?: boolean;
  error?: string | null;
  hint?: React.ReactNode;
}) {
  return (
    <FormField id={id} label={label} error={error} hint={hint}>
      {/* Keyed on value so clearing it back to '' shows the placeholder again. */}
      <Select key={value || 'empty'} value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-invalid={error ? true : undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map(([optionValue, optionLabel]) => (
            <SelectItem key={optionValue} value={optionValue}>{optionLabel}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FormField>
  );
}
