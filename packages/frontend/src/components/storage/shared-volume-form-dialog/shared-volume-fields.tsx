import { FormField } from '../../layout/form-field.js';
import { Input } from '../../ui/input.js';
import { SelectField } from '../volume-form-fields.js';
import { approxGibHint } from '../../../lib/utils.js';
import { formatGrantBytes, formatRemainingBytes } from '../../../lib/grant-quota.js';
import { shrinkNeverTooltip } from '../../../lib/storage-shrink.js';
import type { SharedVolumeForm } from './use-shared-volume-form.js';

const NO_ONLINE_EXECUTOR_HINT = '现在还不能挂载或销毁已有目录';

export function SharedVolumeFields({ form }: { form: SharedVolumeForm }) {
  const { editing, nextSize, shrinkBlocked, liveSharedAccess } = form;
  return (
    <div className="space-y-3">
      <FormField id="shared-volume-name" label="名称">
        <Input id="shared-volume-name" value={form.name} onChange={(event) => form.setName(event.target.value)} />
      </FormField>
      <FormField id="shared-volume-size" label="大小（GiB）">
        <Input
          id="shared-volume-size"
          type="number"
          min="0.001"
          step="any"
          value={form.sizeGiB}
          onChange={(event) => form.setSizeGiB(event.target.value)}
          disabled={shrinkBlocked && Number.isFinite(nextSize) && nextSize < (editing?.sizeBytes ?? 0)}
          title={shrinkBlocked ? shrinkNeverTooltip() : undefined}
        />
        <p className="text-xs text-muted-foreground">
          {Number.isFinite(nextSize) && nextSize > 0
            ? approxGibHint(nextSize)
            : '请输入正数 GiB'}
        </p>
        {shrinkBlocked && (
          <p className="text-xs text-muted-foreground" title={shrinkNeverTooltip()}>
            {shrinkNeverTooltip()}
          </p>
        )}
      </FormField>
      {!editing && (
        <SelectField
          id="volume-shared-backend"
          label="共享后端"
          value={form.sharedBackendId}
          onChange={form.setSharedBackendId}
          options={form.backends.map((backend): [string, string] => [backend.id, backend.displayName ?? backend.name])}
        />
      )}
      {liveSharedAccess && (
        <p className="text-xs text-muted-foreground">
          剩余 {formatRemainingBytes(liveSharedAccess.limitBytes, liveSharedAccess.usedBytes)}
          {' / '}
          额度 {formatGrantBytes(liveSharedAccess.limitBytes)}
        </p>
      )}
      {form.noOnlineExecutor && (
        <p className="text-xs text-muted-foreground" data-testid="shared-volume-no-executor">
          {NO_ONLINE_EXECUTOR_HINT}
        </p>
      )}
      {(form.error || form.floorError || form.quotaError) && (
        <p className="text-sm text-destructive">
          {form.error ?? form.floorError ?? form.quotaError}
        </p>
      )}
    </div>
  );
}
