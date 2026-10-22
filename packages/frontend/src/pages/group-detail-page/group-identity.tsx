import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Pencil, Trash2 } from 'lucide-react';
import { Role, type GroupDto, type UpdateGroupRequest } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { Field, FormField } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { MoreActions } from '../../components/layout/more-actions.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';
import { useGroupMembers, useInvalidateGroup } from '../../lib/group-queries.js';
import { useHasRole } from '../../lib/use-role.js';
import { relativeTime } from '../../lib/utils.js';
import { buildMinimalGroupEditPayload, type GroupEditFormState } from '../../lib/group-edit-form.js';

function GroupIdentityFields({ group }: { group: GroupDto }) {
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <Field label="名称" value={group.name} />
      <Field label="成员" value={`${group.memberCount ?? group.members?.length ?? 0} 人`} />
      <Field label="创建时间" value={relativeTime(group.createdAt)} />
      <Field label="最近更新" value={relativeTime(group.updatedAt)} />
      <div className="sm:col-span-2">
        <Field label="描述" value={group.description ?? '无描述'} />
      </div>
    </div>
  );
}

function GroupIdentityReadOnly({ group }: { group: GroupDto }) {
  return (
    <SectionCard title="身份">
      <GroupIdentityFields group={group} />
    </SectionCard>
  );
}

/** Draft state and saving of a group's description. */
function useGroupEdit(group: GroupDto, onSaved: () => void, onClosed: () => void) {
  const [description, setDescription] = useState(group.description ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: UpdateGroupRequest & { expectedRevision: number }) =>
      api.patch<GroupDto>(`/admin/groups/${group.id}`, body),
    onSuccess: () => {
      toast({ title: '用户组已更新' });
      setError(null);
      onClosed();
      onSaved();
    },
    onError: (mutationError) => {
      const message = errorMessage(mutationError);
      setError(message);
      toast({ title: '更新用户组失败', description: message, variant: 'destructive' });
    },
  });

  const submit = () => {
    setError(null);
    const form: GroupEditFormState = {
      name: group.name,
      description,
    };
    const dirty = new Set<(keyof GroupEditFormState)>();
    if (description !== (group.description ?? '')) dirty.add('description');
    if (dirty.size === 0) {
      toast({ title: '没有需要保存的更改' });
      return;
    }
    const payload = buildMinimalGroupEditPayload(form, dirty, { canEditMetadata: true });
    if (!payload.success) {
      setError(payload.error);
      toast({ title: '无法保存', description: payload.error, variant: 'destructive' });
      return;
    }
    save.mutate({ expectedRevision: group.revision, ...payload.data });
  };

  /** Start from the saved values every time a dialog opens. */
  const reset = () => {
    setDescription(group.description ?? '');
    setError(null);
  };

  return {
    description,
    error,
    pending: save.isPending,
    setDescription,
    submit,
    reset,
  };
}

function GroupIdentityCard({ group }: { group: GroupDto }) {
  const onSaved = useInvalidateGroup(group.id);
  const [identityOpen, setIdentityOpen] = useState(false);
  const edit = useGroupEdit(group, onSaved, () => setIdentityOpen(false));

  return (
    <>
      <SectionCard
        title="身份"
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              edit.reset();
              setIdentityOpen(true);
            }}
          >
            <Pencil className="h-3.5 w-3.5" />编辑
          </Button>
        }
      >
        <GroupIdentityFields group={group} />
      </SectionCard>
      {identityOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) setIdentityOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑用户组</DialogTitle>
            </DialogHeader>
            <FormField id="group-description" label="描述">
              <Input
                id="group-description"
                value={edit.description}
                onChange={(event) => edit.setDescription(event.target.value)}
              />
            </FormField>
            {edit.error && <p className="text-sm text-destructive">{edit.error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setIdentityOpen(false)} disabled={edit.pending}>取消</Button>
              <Button onClick={() => edit.submit()} disabled={edit.pending}>
                {edit.pending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

/** Identity of the group; editable by admins. */
export function GroupOverviewTab({ group }: { group: GroupDto }) {
  const canManage = useHasRole(Role.Admin);
  const members = useGroupMembers(group.id, canManage).data;
  const viewed = {
    ...group,
    members: members ?? group.members ?? [],
    memberCount: members?.length ?? group.memberCount ?? group.members?.length ?? 0,
  };
  return canManage
    ? <GroupIdentityCard key={`${viewed.id}:${viewed.revision}`} group={viewed} />
    : <GroupIdentityReadOnly group={viewed} />;
}

/** Header menu entry that deletes a group after a confirmation. */
export function DeleteGroupAction({ groupId }: { groupId: string }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate({ from: '/groups/$id' });
  const queryClient = useQueryClient();
  const removeGroup = useMutation({
    mutationFn: () => api.delete<unknown>(`/admin/groups/${groupId}`),
    onSuccess: () => {
      toast({ title: '用户组已删除' });
      setOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups.admin });
      void queryClient.invalidateQueries({ queryKey: queryKeys.users.admin });
      void navigate({ to: '/groups' });
    },
    onError: (error) => toast({ title: '删除用户组失败', description: errorMessage(error), variant: 'destructive' }),
  });
  return (
    <>
      <MoreActions actions={[{ label: '删除用户组', icon: Trash2, destructive: true, onSelect: () => setOpen(true) }]} />
      <ConfirmDialog
        open={open}
        title="删除用户组？"
        description="删除后成员关系与资源授权会一并清理，且不可恢复。"
        confirmLabel="确认删除"
        pendingLabel="确认删除"
        pending={removeGroup.isPending}
        onConfirm={() => removeGroup.mutate()}
        onOpenChange={setOpen}
      />
    </>
  );
}
