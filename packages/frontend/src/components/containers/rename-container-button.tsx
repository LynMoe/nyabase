import { useState } from 'react';
import { Pencil } from 'lucide-react';
import {
  CONTAINER_NAME_MAX_LENGTH,
  CONTAINER_NAME_RE,
  type ContainerDto,
  type IntentAcceptedDto,
  type ListScope,
} from '@nyabase/common';
import { useActionMutation } from '../../hooks/use-action-mutation.js';
import { api } from '../../lib/api.js';
import { useInvalidateContainer } from '../../lib/container-queries.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { FormField } from '../layout/form-field.js';
import { Button } from '../ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Hint } from '../ui/hint.js';
import { Input } from '../ui/input.js';

/** The pencil next to a container's name. A deleting container keeps its name. */
export function RenameContainerButton({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const [open, setOpen] = useState(false);
  if (container.lifecyclePhase === 'deleting') return null;
  return (
    <>
      <Hint content="重命名">
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground"
          aria-label="重命名容器"
          data-testid="rename-container"
          onClick={() => setOpen(true)}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </Hint>
      {open ? <RenameContainerDialog container={container} scope={scope} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function RenameContainerDialog({ container, scope, onClose }: { container: ContainerDto; scope: ListScope; onClose: () => void }) {
  const [name, setName] = useState(container.name);
  const invalidate = useInvalidateContainer(scope, container.id);
  const rename = useActionMutation({
    mutationFn: (next: string) => api.patch<IntentAcceptedDto>(scopedPath(`/containers/${container.id}/name`, scope), { name: next }),
    successTitle: '已重命名，正在生效',
    errorTitle: '重命名失败',
    onSuccess: () => {
      invalidate();
      onClose();
    },
  });
  const trimmed = name.trim();
  const problem = trimmed.length === 0 || CONTAINER_NAME_RE.test(trimmed)
    ? null
    : '只能使用小写字母、数字和连字符，且不能以连字符开头';
  const canSubmit = trimmed.length > 0 && !problem && trimmed !== container.name && !rename.isPending;
  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>重命名容器</DialogTitle>
          <DialogDescription>
            改名后请用新名字连接：<code>ssh {container.name}.…</code> 随即失效，已建立的连接不受影响。容器内的提示符在下一次打开 shell 时更新。
          </DialogDescription>
        </DialogHeader>
        <form
          id="rename-container-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) rename.mutate(trimmed);
          }}
        >
          <FormField id="rename-container-name" label="名称" error={problem ?? undefined} hint={`小写字母、数字、连字符，最多 ${CONTAINER_NAME_MAX_LENGTH} 个字符`}>
            <Input
              id="rename-container-name"
              value={name}
              autoFocus
              autoComplete="off"
              maxLength={CONTAINER_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value.toLowerCase())}
            />
          </FormField>
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>取消</Button>
          <Button type="submit" form="rename-container-form" disabled={!canSubmit}>{rename.isPending ? '提交中...' : '重命名'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
