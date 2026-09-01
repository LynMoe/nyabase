import { FormField } from '../layout/form-field.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select.js';

export const GIB = 1024 ** 3;

export function bytesToGiBInput(bytes: number): string {
  const gib = bytes / GIB;
  return Number.isInteger(gib) ? String(gib) : gib.toFixed(3).replace(/\.?0+$/, '');
}

export function SelectField({
  id,
  label,
  value,
  onChange,
  options,
  disabled = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
  disabled?: boolean;
}) {
  return (
    <FormField id={id} label={label}>
      <Select key={value || 'empty'} value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="请选择" />
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
