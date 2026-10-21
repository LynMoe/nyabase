import { useState } from 'react';
import { Pencil, RefreshCw, Server } from 'lucide-react';
import type { StoragePoolDto } from '@nyabase/common';
import { QueryErrorState } from '../query-state.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import { storageOvercommitLabel } from '../../lib/display-labels.js';
import { StoragePoolRow } from './pools-card/storage-pool-row.js';
import { StorageSettingsDialog } from './pools-card/storage-settings-dialog.js';

function poolLabel(pool: StoragePoolDto): string {
  return pool.displayName ?? pool.incusName;
}

export function PoolsCard({
  pools,
  poolsError,
  onRetryPools,
  canManageStoragePools,
  selectedPool,
  systemPoolId,
  currentSystemPool,
  overcommitRatio,
  storageOvercommitRatio,
  discoverPending,
  updatePending,
  onSystemPoolIdChange,
  onOvercommitRatioChange,
  onDiscover,
  onSaveStorage,
  onUpdated,
}: {
  pools: StoragePoolDto[];
  poolsError: unknown | null;
  onRetryPools: () => void;
  canManageStoragePools: boolean;
  selectedPool: StoragePoolDto | undefined;
  systemPoolId: string;
  currentSystemPool: string;
  overcommitRatio: string;
  storageOvercommitRatio: number;
  discoverPending: boolean;
  updatePending: boolean;
  onSystemPoolIdChange: (value: string) => void;
  onOvercommitRatioChange: (value: string) => void;
  onDiscover: () => void;
  onSaveStorage: () => void;
  onUpdated: () => void;
}) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const selectedSystemPool = pools.find((pool) => pool.id === (systemPoolId || currentSystemPool));
  return (
    <Card data-testid="storage-pool-capabilities">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><HardDriveIcon />存储池能力</CardTitle>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <Pencil className="h-3.5 w-3.5" />编辑存储设置
            </Button>
            <Button variant="outline" size="sm" onClick={onDiscover} disabled={discoverPending}>
              <RefreshCw className={discoverPending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />发现存储池
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-muted-foreground">系统盘池</p>
            <p className="text-sm">{selectedSystemPool ? poolLabel(selectedSystemPool) : '未指定'}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">存储超分比例</p>
            <p className="text-sm">{storageOvercommitLabel(overcommitRatio || storageOvercommitRatio)}</p>
          </div>
        </div>
        {settingsOpen ? (
          <StorageSettingsDialog
            pools={pools}
            systemPoolId={systemPoolId}
            currentSystemPool={currentSystemPool}
            overcommitRatio={overcommitRatio}
            storageOvercommitRatio={storageOvercommitRatio}
            updatePending={updatePending}
            onSystemPoolIdChange={onSystemPoolIdChange}
            onOvercommitRatioChange={onOvercommitRatioChange}
            onSave={() => {
              onSaveStorage();
              setSettingsOpen(false);
            }}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
        {poolsError ? (
          <QueryErrorState error={poolsError} resourceName="存储池" onRetry={onRetryPools} />
        ) : pools.length === 0 ? (
          <p className="text-sm text-muted-foreground">尚未发现本地存储池。</p>
        ) : (
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                <tr><th className="px-3 py-2">池</th><th className="px-3 py-2">位置</th><th className="px-3 py-2">容量</th><th className="px-3 py-2">能力</th><th className="px-3 py-2">登记</th><th className="px-3 py-2">操作</th></tr>
              </thead>
              <tbody>
                {pools.map((pool) => (
                  <StoragePoolRow
                    key={pool.id}
                    pool={pool}
                    canManageStoragePools={canManageStoragePools}
                    onUpdated={onUpdated}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {selectedPool && <p className="text-xs text-muted-foreground">探针池：{selectedPool.displayName ?? selectedPool.incusName}</p>}
        {!canManageStoragePools && (
          <p className="text-xs text-muted-foreground" data-testid="storage-pool-register-gated">
            可以查看存储池，但登记、取消登记与编辑备注需要「管理存储池」权限。
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function HardDriveIcon() {
  return <Server className="h-4 w-4" />;
}
