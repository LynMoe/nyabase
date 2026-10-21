import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { Capability, type GroupDto, type UpdateGroupRequest } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Checkbox } from '../../components/ui/checkbox.js';
import { Input } from '../../components/ui/input.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { Field } from '../../components/layout/form-field.js';
import { FormField } from '../../components/layout/form-field.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { toast } from '../../hooks/use-toast.js';
import { capabilityLabel } from '../../lib/display-labels.js';
import { relativeTime } from '../../lib/utils.js';
import {
  buildMinimalGroupEditPayload,
  type GroupEditFormState,
} from '../../lib/group-edit-form.js';

function GroupIdentityFields({ group }: { group: GroupDto }) {
  return (
    <div className="grid gap-3 text-sm sm:grid-cols-2">
      <Field label="名称" value={group.name} />
      <Field label="类型" value={group.isSystem ? '系统组' : '自定义组'} />
      <Field label="成员" value={`${group.memberCount ?? group.members?.length ?? 0} 人`} />
      <Field label="创建时间" value={relativeTime(group.createdAt)} />
      <Field label="最近更新" value={relativeTime(group.updatedAt)} />
      <div className="sm:col-span-2">
        <Field label="描述" value={group.description ?? '无描述'} />
      </div>
    </div>
  );
}

function CapabilityBadges({ capabilities }: { capabilities: readonly Capability[] }) {
  if (capabilities.length === 0) {
    return <p className="text-sm text-muted-foreground">无。</p>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {capabilities.map((capability) => (
        <Badge key={capability} variant="outline">{capabilityLabel(capability)}</Badge>
      ))}
    </div>
  );
}

function capabilitiesDescription(group: GroupDto): string {
  return group.isSystem ? '内置用户组的能力不可修改。' : '移除能力会立即影响该组成员。';
}

function capabilitiesChanged(left: readonly Capability[], right: readonly Capability[]): boolean {
  if (left.length !== right.length) return true;
  const rightSet = new Set(right);
  return left.some((capability) => !rightSet.has(capability));
}

export function GroupIdentityReadOnly({ group }: { group: GroupDto }) {
  return (
    <>
      <SectionCard title="身份">
        <GroupIdentityFields group={group} />
      </SectionCard>
      <SectionCard title="能力" description={capabilitiesDescription(group)}>
        <CapabilityBadges capabilities={group.capabilities} />
      </SectionCard>
    </>
  );
}

/** Draft state and saving of a group's description and capabilities. */
function useGroupEdit(group: GroupDto, onSaved: () => void, onClosed: () => void) {
  const [description, setDescription] = useState(group.description ?? '');
  const [capabilities, setCapabilities] = useState<Capability[]>([...group.capabilities]);
  const [confirmRemoval, setConfirmRemoval] = useState<Capability[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: UpdateGroupRequest & { expectedRevision: number }) =>
      api.patch<GroupDto>(`/admin/groups/${group.id}`, body),
    onSuccess: () => {
      toast({ title: '用户组已更新' });
      setConfirmRemoval(null);
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

  const submit = (skipConfirm = false) => {
    setError(null);
    const form: GroupEditFormState = {
      name: group.name,
      description,
      capabilities,
    };
    const dirty = new Set<(keyof GroupEditFormState)>();
    if (description !== (group.description ?? '')) dirty.add('description');
    if (!group.isSystem && capabilitiesChanged(group.capabilities, capabilities)) dirty.add('capabilities');
    if (dirty.size === 0) {
      toast({ title: '没有需要保存的更改' });
      return;
    }
    const removed = group.isSystem
      ? []
      : group.capabilities.filter((capability) => !capabilities.includes(capability));
    if (!skipConfirm && removed.length > 0) {
      setConfirmRemoval(removed);
      return;
    }
    const payload = buildMinimalGroupEditPayload(form, dirty, {
      isSystem: group.isSystem,
      canEditMetadata: true,
    });
    if (!payload.success) {
      setError(payload.error);
      toast({ title: '无法保存', description: payload.error, variant: 'destructive' });
      return;
    }
    save.mutate({ expectedRevision: group.revision, ...payload.data });
  };

  const toggleCapability = (capability: Capability, checked: boolean) => {
    setCapabilities((current) => (
      checked
        ? (current.includes(capability) ? current : [...current, capability])
        : current.filter((item) => item !== capability)
    ));
  };

  /** Start from the saved values every time a dialog opens. */
  const reset = () => {
    setDescription(group.description ?? '');
    setCapabilities([...group.capabilities]);
    setError(null);
  };

  return {
    description,
    capabilities,
    confirmRemoval,
    error,
    pending: save.isPending,
    setDescription,
    setConfirmRemoval,
    toggleCapability,
    submit,
    reset,
  };
}

export function GroupIdentityCard({ group, onSaved }: { group: GroupDto; onSaved: () => void }) {
  const [identityOpen, setIdentityOpen] = useState(false);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const edit = useGroupEdit(group, onSaved, () => {
    setIdentityOpen(false);
    setCapabilitiesOpen(false);
  });

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
      <SectionCard
        title="能力"
        description={capabilitiesDescription(group)}
        actions={
          !group.isSystem ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                edit.reset();
                setCapabilitiesOpen(true);
              }}
            >
              <Pencil className="h-3.5 w-3.5" />编辑
            </Button>
          ) : undefined
        }
      >
        <CapabilityBadges capabilities={group.capabilities} />
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
      {capabilitiesOpen ? (
        <Dialog open onOpenChange={(open) => { if (!open) setCapabilitiesOpen(false); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>编辑能力</DialogTitle>
              <DialogDescription>移除能力会立即影响该组成员。</DialogDescription>
            </DialogHeader>
            <fieldset className="space-y-2">
              <legend className="sr-only">能力</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {Object.values(Capability).map((capability) => (
                  <label key={capability} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={`group-capability-${capability}`}
                      checked={edit.capabilities.includes(capability)}
                      onCheckedChange={(checked) => edit.toggleCapability(capability, checked === true)}
                    />
                    <span>{capabilityLabel(capability)}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            {edit.error && <p className="text-sm text-destructive">{edit.error}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setCapabilitiesOpen(false)} disabled={edit.pending}>取消</Button>
              <Button onClick={() => edit.submit()} disabled={edit.pending}>
                {edit.pending ? '保存中...' : '保存'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      <ConfirmDialog
        open={Boolean(edit.confirmRemoval)}
        title="移除用户组能力？"
        description={`将移除：${(edit.confirmRemoval ?? []).map((capability) => capabilityLabel(capability)).join('、')}。该组成员会立即失去这些能力。`}
        confirmLabel="确认移除并保存"
        pendingLabel="保存中..."
        pending={edit.pending}
        onConfirm={() => edit.submit(true)}
        onOpenChange={(open) => { if (!open) edit.setConfirmRemoval(null); }}
      />
    </>
  );
}
