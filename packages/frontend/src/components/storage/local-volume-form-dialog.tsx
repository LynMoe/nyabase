import { Button } from '../ui/button.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog.js';
import { shrinkNeverTooltip } from '../../lib/storage-shrink.js';
import {
  type LocalVolumeForm,
  type LocalVolumeFormProps,
  useLocalVolumeForm,
} from './use-local-volume-form.js';
import { VolumeShrinkOrchestrationDialog } from './volume-shrink-orchestration-dialog.js';
import { FormField } from '../layout/form-field.js';
import { Input } from '../ui/input.js';
import { SelectField } from '../layout/form-field.js';
import { approxGibHint, formatGib, grantAvailableLabel } from '../../lib/utils.js';
import { formatGrantBytes } from '../../lib/grant-quota.js';

export function LocalVolumeFormDialog(props: LocalVolumeFormProps) {
  const { volume, open, onOpenChange } = props;
  const form = useLocalVolumeForm(props);
  const { editing, orchestrate, nextSize, quotaError, shrinkBlocked, path } = form;

  return (
    <>
      <Dialog open={open && !orchestrate} onOpenChange={onOpenChange}>
        <DialogContent data-testid="volume-form">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑数据卷' : '新建数据卷'}</DialogTitle>
            {form.description ? <DialogDescription>{form.description}</DialogDescription> : null}
          </DialogHeader>
          <LocalVolumeFields form={form} />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button
              onClick={form.submit}
              disabled={form.pending || Boolean(form.floorError) || Boolean(quotaError) || (shrinkBlocked && path === 'never')}
              title={quotaError ?? (shrinkBlocked && path === 'never' ? shrinkNeverTooltip() : undefined)}
            >
              {form.pending ? '提交中...' : path === 'requires_stop' ? '继续缩容编排' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {volume && orchestrate && Number.isFinite(nextSize) && (
        <VolumeShrinkOrchestrationDialog
          volume={{ ...volume, name: form.name.trim() || volume.name }}
          sizeBytes={nextSize}
          open={orchestrate}
          onOpenChange={(next) => {
            form.setOrchestrate(next);
            if (!next) onOpenChange(false);
          }}
          onComplete={() => {
            form.data.invalidateVolumeLists();
          }}
        />
      )}
    </>
  );
}

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
