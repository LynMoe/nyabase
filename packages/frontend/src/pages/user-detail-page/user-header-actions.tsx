import { KeyRound, Trash2 } from 'lucide-react';
import { UserStatus, type UserDto } from '@nyabase/common';
import { Button } from '../../components/ui/button.js';
import { MoreActions } from '../../components/layout/more-actions.js';

/** Enable / disable, reset password and delete — for administrators looking at someone else. */
export function UserHeaderActions({
  user,
  patchPending,
  onEnable,
  onDisable,
  onReset,
  onDelete,
}: {
  user: UserDto;
  patchPending: boolean;
  onEnable: () => void;
  onDisable: () => void;
  onReset: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      {user.status === UserStatus.Disabled ? (
        <Button variant="outline" disabled={patchPending} onClick={onEnable}>
          启用
        </Button>
      ) : (
        <Button variant="outline" onClick={onDisable}>停用</Button>
      )}
      <Button variant="outline" onClick={onReset}>
        <KeyRound className="h-4 w-4" />重置密码
      </Button>
      <MoreActions actions={[{ label: '删除用户', icon: Trash2, destructive: true, onSelect: onDelete }]} />
    </>
  );
}
