import { FormField } from '../../layout/form-field.js';
import { Input } from '../../ui/input.js';
import { SelectField } from '../volume-form-fields.js';
import { approxGibHint, grantAvailableLabel, formatGib } from '../../../lib/utils.js';
import { formatGrantBytes } from '../../../lib/grant-quota.js';
import { shrinkNeverTooltip } from '../../../lib/storage-shrink.js';
import type { LocalVolumeForm } from './use-local-volume-form.js';

/** Remaining capacity under the size field: physical for administrators, grant-based for owners. */
function CapacityHint({ form }: { form: LocalVolumeForm }) {
  const { selectedCapacityPool } = form;
  const capacity = form.data.capacityQuery.data;
  if (form.scope === 'all') {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">
          池剩余（物理，含超分；不是该用户的磁盘额度）。
        </p>
        {selectedCapacityPool ? (
          <p className="text-xs text-muted-foreground">
            {selectedCapacityPool.availableBytes === null
              ? '物理剩余未知'
              : `物理剩余 ${formatGib(selectedCapacityPool.availableBytes)}`}
            {selectedCapacityPool.quotaEffective === true ? ' · 配额生效' : ' · 配额未生效'}
          </p>
        ) : null}
      </div>
    );
  }
  if (!capacity) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {capacity.grantLimitBytes === null || capacity.grantLimitBytes === 0
        ? '额度不限'
        : `剩余 ${grantAvailableLabel(capacity.availableBytes, capacity.grantLimitBytes)} / 额度 ${formatGrantBytes(capacity.grantLimitBytes)}`}
    </p>
  );
}

/** Server and pool pickers (creation only), with the selected pool's usage. */
function PlacementFields({ form }: { form: LocalVolumeForm }) {
  const { selectedPool, serverId } = form;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          id="volume-server"
          label="服务器"
          value={serverId}
          onChange={(value) => {
            form.setServerId(value);
            form.setPoolId(form.poolLocked ? (form.lockedPoolId ?? '') : '');
          }}
          options={form.servers.map((server): [string, string] => [server.id, server.name])}
          disabled={form.serverLocked}
        />
        <SelectField
          key={serverId || 'no-server'}
          id="volume-pool"
          label="存储池"
          value={form.poolId}
          onChange={form.setPoolId}
          options={form.localPools.map((pool): [string, string] => [pool.id, pool.displayName ?? pool.incusName])}
          disabled={!serverId || form.poolLocked}
        />
      </div>
      {selectedPool && (
        <p className="text-xs text-muted-foreground">
          已选池：{selectedPool.displayName ?? selectedPool.incusName}
          {selectedPool.totalBytes === null
            ? ' · 容量未知'
            : ` · ${formatGib(selectedPool.usedBytes ?? 0)} / ${formatGib(selectedPool.totalBytes)}`}
          {selectedPool.quotaEffective === true ? ' · 配额生效' : ' · 配额未生效'}
        </p>
      )}
    </>
  );
}

export function LocalVolumeFields({ form }: { form: LocalVolumeForm }) {
  const { editing, nextSize, shrinkBlocked, quotaError, floorError, error } = form;
  return (
    <div className="space-y-3">
      <FormField id="volume-name" label="名称">
        <Input id="volume-name" value={form.name} onChange={(event) => form.setName(event.target.value)} />
      </FormField>
      <FormField id="volume-size" label="大小（GiB）">
        <Input
          id="volume-size"
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
        <CapacityHint form={form} />
        {shrinkBlocked && (
          <p className="text-xs text-muted-foreground" title={shrinkNeverTooltip()}>
            {shrinkNeverTooltip()}
          </p>
        )}
      </FormField>
      {!editing && <PlacementFields form={form} />}
      {(error || floorError || quotaError) && (
        <p className="text-sm text-destructive" data-testid={quotaError ? 'volume-quota-ineffective' : undefined}>
          {error ?? floorError ?? quotaError}
        </p>
      )}
    </div>
  );
}
