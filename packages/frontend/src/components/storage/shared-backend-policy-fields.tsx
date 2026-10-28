import { MAX_SHARED_BACKEND_NOTE_LENGTH } from '@nyabase/common';
import { parseMaxVolumesPerUser } from '../../lib/shared-backend-form.js';
import { FormField } from '../layout/form-field.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';

/** What users see and may hold on a shared backend: the note shown when they create a volume, the per-user cap. */
export function SharedBackendPolicyFields({
  idPrefix,
  note,
  onNoteChange,
  maxVolumes,
  onMaxVolumesChange,
}: {
  idPrefix: string;
  note: string;
  onNoteChange: (value: string) => void;
  maxVolumes: string;
  onMaxVolumesChange: (value: string) => void;
}) {
  const invalid = parseMaxVolumesPerUser(maxVolumes) === undefined;
  return (
    <>
      <FormField id={`${idPrefix}-note`} label="备注" hint="用户创建共享卷时显示，例如用途、备份策略">
        <Textarea
          id={`${idPrefix}-note`}
          rows={2}
          maxLength={MAX_SHARED_BACKEND_NOTE_LENGTH}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
        />
      </FormField>
      <FormField
        id={`${idPrefix}-max-volumes`}
        label="每用户最多共享卷"
        hint="留空为不限；调低不影响已有的卷，只拒绝新建"
        error={invalid ? '请输入 1 到 10000 的整数' : null}
      >
        <Input
          id={`${idPrefix}-max-volumes`}
          type="number"
          min="1"
          step="1"
          placeholder="不限"
          value={maxVolumes}
          aria-invalid={invalid ? true : undefined}
          onChange={(event) => onMaxVolumesChange(event.target.value)}
        />
      </FormField>
    </>
  );
}
