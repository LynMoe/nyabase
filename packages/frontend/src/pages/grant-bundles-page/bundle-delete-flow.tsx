import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FailureCode, type GrantBundleDto } from '@nyabase/common';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { toast } from '../../hooks/use-toast.js';
import { api } from '../../lib/api.js';
import { ApiError, apiErrorDetails } from '../../lib/api-error.js';
import { bundleInUseUsers } from '../../lib/grant-bundle-form.js';
import { queryKeys } from '../../lib/query-keys.js';
import { bundleErrorText } from './bundle-form-dialogs.js';

/** The users still holding a bundle that could not be deleted. */
interface InUse {
  bundleName: string;
  users: Array<{ userId: string; username: string }>;
}

/** Confirm a delete; a bundle still assigned is refused with the users holding it. */
export function BundleDeleteFlow({ bundle, onClose }: { bundle: GrantBundleDto | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [inUse, setInUse] = useState<InUse | null>(null);
  const remove = useMutation({
    mutationFn: (target: GrantBundleDto) => api.delete<void>(`/admin/grant-bundles/${target.id}`),
    onSuccess: () => {
      toast({ title: '授权模板已删除' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.grantBundles.all });
      onClose();
    },
    onError: (error, target) => {
      if (error instanceof ApiError && error.code === FailureCode.GrantBundleInUse) {
        setInUse({ bundleName: target.name, users: bundleInUseUsers(apiErrorDetails(error)) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.grantBundles.all });
        onClose();
        return;
      }
      toast({ title: '删除授权模板失败', description: bundleErrorText(error), variant: 'destructive' });
    },
  });
  return (
    <>
      <ConfirmDialog
        open={bundle !== null}
        title="删除授权模板？"
        description={bundle && bundle.grantCount > 0
          ? `「${bundle.name}」仍有 ${bundle.grantCount} 个用户在使用，需先为他们替换或删除该授权才能删除。`
          : `将删除「${bundle?.name ?? ''}」，不可恢复。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={remove.isPending}
        onConfirm={() => { if (bundle) remove.mutate(bundle); }}
        onOpenChange={(open) => { if (!open) onClose(); }}
      />
      <Dialog open={inUse !== null} onOpenChange={(open) => { if (!open) setInUse(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>无法删除「{inUse?.bundleName}」</DialogTitle>
            <DialogDescription>以下用户仍在使用该模板，请先在他们的授权页替换为其他模板或删除该授权。</DialogDescription>
          </DialogHeader>
          <ul className="max-h-64 space-y-1 overflow-y-auto text-sm" data-testid="grant-bundle-in-use">
            {(inUse?.users ?? []).map((user) => (
              <li key={user.userId}>
                <Link to="/users/$id" params={{ id: user.userId }} search={{ tab: 'grants' }} className="font-mono underline">
                  @{user.username}
                </Link>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button onClick={() => setInUse(null)}>知道了</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
