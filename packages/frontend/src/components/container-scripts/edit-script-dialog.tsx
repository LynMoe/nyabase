import { useEffect, useState } from 'react';
import {
  CONTAINER_SCRIPT_PRIORITY_MAX,
  CONTAINER_SCRIPT_PRIORITY_MIN,
  type ContainerScriptDto,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { FormField } from '../layout/form-field.js';
import { toast } from '../../hooks/use-toast.js';
import { containerScriptErrorMessage } from '../../lib/container-scripts.js';
import { scriptEditForm, scriptPatchFromEdit, type ScriptEditForm } from '../../lib/container-script-form.js';
import { useScriptActions } from './use-script-actions.js';

/** 编辑: name, description and priority; the script and its settings change by publishing a version. */
export function EditScriptDialog({
  script,
  open,
  onOpenChange,
}: {
  script: ContainerScriptDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { patch } = useScriptActions(script.id);
  const [edit, setEdit] = useState<ScriptEditForm>(() => scriptEditForm(script));
  const [attempted, setAttempted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEdit(scriptEditForm(script));
    setAttempted(false);
    setServerError(null);
    // Read when the dialog opens; a refreshed script must not reset the draft.
  }, [open]);

  const result = scriptPatchFromEdit(script, edit);
  const errors = attempted ? result.errors ?? {} : {};
  const update = (changes: Partial<ScriptEditForm>) => {
    setEdit((current) => ({ ...current, ...changes }));
    setServerError(null);
  };
  const submit = () => {
    setAttempted(true);
    if (result.errors) return;
    if (!result.body) {
      toast({ title: '没有需要保存的修改' });
      onOpenChange(false);
      return;
    }
    patch.mutate(result.body, {
      onSuccess: () => onOpenChange(false),
      onError: (error) => setServerError(containerScriptErrorMessage(error)),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!patch.isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-lg" data-testid="container-script-edit">
        <DialogHeader>
          <DialogTitle>编辑容器脚本</DialogTitle>
          <DialogDescription>脚本内容、文件、范围和执行设置要通过“发布新版本”修改。</DialogDescription>
        </DialogHeader>
        <FormField id="container-script-edit-name" label="名称" error={errors.name}>
          <Input id="container-script-edit-name" value={edit.name} maxLength={128} onChange={(event) => update({ name: event.target.value })} />
        </FormField>
        <FormField id="container-script-edit-description" label="说明" error={errors.description}>
          <Input
            id="container-script-edit-description"
            value={edit.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </FormField>
        <FormField
          id="container-script-edit-priority"
          label="优先级"
          hint={`越小越先执行，${CONTAINER_SCRIPT_PRIORITY_MIN}–${CONTAINER_SCRIPT_PRIORITY_MAX}，不能与其他脚本相同`}
          error={errors.priority}
        >
          <Input
            id="container-script-edit-priority"
            type="number"
            inputMode="numeric"
            className="font-mono"
            value={edit.priority}
            onChange={(event) => update({ priority: event.target.value })}
          />
        </FormField>
        {serverError ? <p className="text-sm text-destructive">{serverError}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={patch.isPending}>取消</Button>
          <Button onClick={submit} disabled={patch.isPending}>{patch.isPending ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
