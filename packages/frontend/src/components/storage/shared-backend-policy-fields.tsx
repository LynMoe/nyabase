import { MAX_SHARED_BACKEND_NOTE_LENGTH } from '@nyabase/common';
import { FormField } from '../layout/form-field.js';
import { Textarea } from '../ui/textarea.js';

/** What users see about a shared backend: the note shown next to their volume on it. */
export function SharedBackendPolicyFields({
  idPrefix,
  note,
  onNoteChange,
}: {
  idPrefix: string;
  note: string;
  onNoteChange: (value: string) => void;
}) {
  return (
    <FormField id={`${idPrefix}-note`} label="备注" hint="显示在用户的共享卷旁，例如用途、备份策略">
      <Textarea
        id={`${idPrefix}-note`}
        rows={2}
        maxLength={MAX_SHARED_BACKEND_NOTE_LENGTH}
        value={note}
        onChange={(event) => onNoteChange(event.target.value)}
      />
    </FormField>
  );
}
