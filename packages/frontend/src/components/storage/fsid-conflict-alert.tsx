import { TriangleAlert } from 'lucide-react';
import type { SharedBackendFsidConflict } from '../../lib/storage-shrink.js';

export function FsidConflictAlert({
  conflict,
  onDismiss,
}: {
  conflict: SharedBackendFsidConflict;
  onDismiss?: () => void;
}) {
  return (
    <div
      className="flex items-start gap-2 rounded-md border border-destructive bg-destructive/10 px-3 py-3 text-sm text-destructive"
      data-testid="shared-backend-fsid-conflict"
      role="alert"
    >
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">共享后端 FSID 冲突</p>
        <p>{conflict.message}</p>
        <dl className="grid gap-1 font-mono text-xs">
          {conflict.identityKey && (
            <div><dt className="inline text-destructive/80">identity_key：</dt><dd className="inline break-all">{conflict.identityKey}</dd></div>
          )}
          {conflict.expectedFsid && (
            <div><dt className="inline text-destructive/80">已登记 FSID：</dt><dd className="inline break-all">{conflict.expectedFsid}</dd></div>
          )}
          {conflict.conflictingFsid && (
            <div><dt className="inline text-destructive/80">冲突 FSID：</dt><dd className="inline break-all">{conflict.conflictingFsid}</dd></div>
          )}
        </dl>
        <p className="text-xs text-destructive/90">
          相同 identity_key 必须对应同一 Ceph 集群 FSID；发现或登记时不一致将被拒绝合并。
        </p>
        {onDismiss && (
          <button type="button" className="text-xs underline underline-offset-2" onClick={onDismiss}>
            关闭告警
          </button>
        )}
      </div>
    </div>
  );
}
