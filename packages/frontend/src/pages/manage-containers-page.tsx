import { useQuery } from '@tanstack/react-query';
import { Container, UserRound, RefreshCw } from 'lucide-react';
import type { ContainerView } from '@nyabase/common';

import { api } from '../lib/api.js';
import { Card, CardContent } from '../components/ui/card.js';
import { Button, buttonVariants } from '../components/ui/button.js';
import { Separator } from '../components/ui/separator.js';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '../components/ui/alert-dialog.js';
import { ContainerRow } from '../components/containers/container-row.js';
import { useContainerActions } from '../hooks/use-container-actions.js';
import { cn } from '../lib/utils.js';
import { queryKeys } from '../lib/query-keys.js';

export default function ManageContainersPage() {
  const { doAction, confirmState, handleConfirm, handleCancel } =
    useContainerActions({ admin: true });

  const { data: containers = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: queryKeys.containers.adminList,
    queryFn: () => api.get<ContainerView[]>('/admin/v2/containers'),
    refetchInterval: 8_000,
  });

  const grouped = containers.reduce<Map<string, { ownerName: string; items: ContainerView[] }>>(
    (acc, c) => {
      const { ownerId } = c;
      if (!acc.has(ownerId)) acc.set(ownerId, { ownerName: c.ownerName ?? ownerId.slice(0, 8), items: [] });
      acc.get(ownerId)!.items.push(c);
      return acc;
    },
    new Map(),
  );
  const groups = [...grouped.entries()]
    .sort(([, a], [, b]) => a.ownerName.localeCompare(b.ownerName));

  return (
    <div className="p-6 space-y-6 w-full">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">容器管理</h1>
          <p className="text-muted-foreground text-sm">
            全局共 {containers.length} 个容器，{groups.length} 位用户
          </p>
        </div>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
        </Button>
      </div>

      {isLoading ? (
        <Card><CardContent className="h-32 animate-pulse bg-muted/50 rounded-lg mt-6" /></Card>
      ) : containers.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 space-y-3">
            <Container className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">暂无任何容器</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {groups.map(([ownerId, group]) => (
            <div key={ownerId}>
              <div className="flex items-center gap-2 mb-2 px-1">
                <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                <span className="text-sm font-medium">{group.ownerName}</span>
                <span className="text-xs text-muted-foreground">{group.items.length} 个容器</span>
              </div>
              <Card>
                <CardContent className="p-0">
                  {group.items.map((c, i) => (
                    <div key={c.id}>
                      <ContainerRow
                        container={c}
                        onAction={doAction}
                        linkToDetail={false}
                      />
                      {i < group.items.length - 1 && <Separator />}
                    </div>
                  ))}
                </CardContent>
              </Card>
            </div>
          ))}
        </div>
      )}

      <AlertDialog open={!!confirmState} onOpenChange={(open) => { if (!open) handleCancel(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmState?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmState?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleCancel}>取消</AlertDialogCancel>
            <AlertDialogAction
              className={cn(
                confirmState?.variant === 'destructive' && buttonVariants({ variant: 'destructive' }),
              )}
              onClick={() => void handleConfirm()}
            >
              {confirmState?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
