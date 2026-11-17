import { useState } from 'react';
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react';
import {
  CONTAINER_SCRIPT_MAX_ATTEMPTS_LIMIT,
  CONTAINER_SCRIPT_PRIORITY_MAX,
  CONTAINER_SCRIPT_PRIORITY_MIN,
  CONTAINER_SCRIPT_TIMEOUT_MAX_SECONDS,
  CONTAINER_SCRIPT_TIMEOUT_MIN_SECONDS,
  ContainerScriptStoppedPolicy,
} from '@nyabase/common';
import { Alert, AlertDescription } from '../ui/alert.js';
import { Button } from '../ui/button.js';
import { Checkbox } from '../ui/checkbox.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Textarea } from '../ui/textarea.js';
import { FormField } from '../layout/form-field.js';
import { SegmentedFilter } from '../layout/list-search.js';
import {
  applyNowHint,
  confirmLines,
  stoppedPolicyApplies,
  type ScriptForm,
  type ScriptFormErrors,
  type ScriptFormField,
} from '../../lib/container-script-form.js';
import { ScopePreviewSummary, ScriptScopeFields } from './script-scope-fields.js';
import { ScriptFilesField } from './script-files-field.js';
import { useScopeOptions } from './use-scope-options.js';
import { useScriptForm, type ScriptFormArgs, type ScriptFormState } from './use-script-form.js';

const STOPPED_POLICIES = [
  { value: ContainerScriptStoppedPolicy.Wait, label: '开机后执行' },
  { value: ContainerScriptStoppedPolicy.Skip, label: '跳过' },
] as const;

const ADVANCED_FIELDS: ScriptFormField[] = [
  'timeoutSeconds', 'maxAttempts', 'maxParallel', 'maxParallelPerServer', 'canaryCount', 'pauseAfterFailures',
];

type Update = (changes: Partial<ScriptForm>) => void;

/** Create only: name, description, priority. */
function BasicsFields({ form, update, errors }: { form: ScriptForm; update: Update; errors: ScriptFormErrors }) {
  return (
    <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <FormField id="container-script-name" label="名称" error={errors.fields.name}>
        <Input id="container-script-name" value={form.name} maxLength={128} onChange={(event) => update({ name: event.target.value })} />
      </FormField>
      <FormField
        id="container-script-priority"
        label="优先级（可选）"
        hint={`越小越先执行，${CONTAINER_SCRIPT_PRIORITY_MIN}–${CONTAINER_SCRIPT_PRIORITY_MAX}`}
        error={errors.fields.priority}
      >
        <Input
          id="container-script-priority"
          type="number"
          inputMode="numeric"
          className="font-mono"
          placeholder="默认排在最后"
          value={form.priority}
          onChange={(event) => update({ priority: event.target.value })}
        />
      </FormField>
      <div className="sm:col-span-2">
        <FormField id="container-script-description" label="说明（可选）" error={errors.fields.description}>
          <Input
            id="container-script-description"
            value={form.description}
            onChange={(event) => update({ description: event.target.value })}
          />
        </FormField>
      </div>
    </div>
  );
}

function TriggerCheckbox({
  id,
  label,
  checked,
  disabled = false,
  onChange,
  hint,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-center gap-2 text-sm">
        <Checkbox id={id} checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
        <span className={disabled ? 'text-muted-foreground' : undefined}>{label}</span>
      </label>
      {hint ? <p className="pl-6 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** 立即 / 新容器 / 每次开机, and what happens to stopped containers on 立即. */
function TriggerFields({
  form,
  update,
  errors,
  creating,
}: {
  form: ScriptForm;
  update: Update;
  errors: ScriptFormErrors;
  creating: boolean;
}) {
  return (
    <section className="space-y-3 rounded-md border p-3" data-testid="container-script-triggers">
      <p className="text-sm font-medium">触发</p>
      <TriggerCheckbox
        id="container-script-apply-now"
        label="立即"
        checked={form.applyNow}
        onChange={(applyNow) => update({ applyNow })}
        hint={applyNowHint(form.everyBoot)}
      />
      <TriggerCheckbox
        id="container-script-new-containers"
        label="新容器"
        checked={form.everyBoot || form.onNewContainers}
        disabled={form.everyBoot}
        onChange={(onNewContainers) => update({ onNewContainers })}
        hint={form.everyBoot ? '每次开机已包含新容器的第一次开机' : '发布后进入范围的新容器创建后执行一次'}
      />
      <TriggerCheckbox
        id="container-script-every-boot"
        label="每次开机"
        checked={form.everyBoot}
        disabled={!creating}
        onChange={(everyBoot) => update({ everyBoot })}
        hint={creating ? '范围内的容器每次开机后都执行；创建后不能更改' : '创建时已确定，不能更改'}
      />
      {stoppedPolicyApplies(form) ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <span className="text-sm text-muted-foreground">停机容器</span>
          <SegmentedFilter
            label="停机容器"
            value={form.stoppedPolicy}
            options={STOPPED_POLICIES}
            onChange={(stoppedPolicy) => update({ stoppedPolicy })}
          />
        </div>
      ) : null}
      {errors.fields.triggers ? <p className="text-sm text-destructive">{errors.fields.triggers}</p> : null}
    </section>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  placeholder,
  hint,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  hint?: string;
  error?: string;
}) {
  return (
    <FormField id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        className="font-mono"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </FormField>
  );
}

/** 高级: run limits, concurrency, canary and auto-pause, and the version note. */
function AdvancedFields({ form, update, errors }: { form: ScriptForm; update: Update; errors: ScriptFormErrors }) {
  const hasError = ADVANCED_FIELDS.some((field) => errors.fields[field]);
  const [expanded, setExpanded] = useState(false);
  const open = expanded || hasError;
  return (
    <section className="space-y-3 rounded-md border p-3">
      <button
        type="button"
        className="inline-flex items-center gap-1 text-sm font-medium"
        aria-expanded={open}
        onClick={() => setExpanded((current) => !current)}
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}高级
      </button>
      {open ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField
            id="container-script-timeout"
            label="超时（秒）"
            value={form.timeoutSeconds}
            onChange={(timeoutSeconds) => update({ timeoutSeconds })}
            hint={`${CONTAINER_SCRIPT_TIMEOUT_MIN_SECONDS}–${CONTAINER_SCRIPT_TIMEOUT_MAX_SECONDS}`}
            error={errors.fields.timeoutSeconds}
          />
          <NumberField
            id="container-script-max-attempts"
            label="最多尝试次数"
            value={form.maxAttempts}
            onChange={(maxAttempts) => update({ maxAttempts })}
            hint={`1–${CONTAINER_SCRIPT_MAX_ATTEMPTS_LIMIT}，失败后按退避重试`}
            error={errors.fields.maxAttempts}
          />
          <NumberField
            id="container-script-max-parallel"
            label="同时执行数（全平台）"
            value={form.maxParallel}
            onChange={(maxParallel) => update({ maxParallel })}
            placeholder="不额外限制"
            error={errors.fields.maxParallel}
          />
          <NumberField
            id="container-script-max-parallel-per-server"
            label="同时执行数（每台服务器）"
            value={form.maxParallelPerServer}
            onChange={(maxParallelPerServer) => update({ maxParallelPerServer })}
            placeholder="不额外限制"
            error={errors.fields.maxParallelPerServer}
          />
          <NumberField
            id="container-script-canary"
            label="灰度台数"
            value={form.canaryCount}
            onChange={(canaryCount) => update({ canaryCount })}
            placeholder="不灰度"
            hint="这么多容器执行完此版本后自动暂停，等你确认后恢复"
            error={errors.fields.canaryCount}
          />
          <NumberField
            id="container-script-pause-after"
            label="失败自动暂停阈值"
            value={form.pauseAfterFailures}
            onChange={(pauseAfterFailures) => update({ pauseAfterFailures })}
            placeholder="不自动暂停"
            hint="此版本失败的容器达到这个数就暂停"
            error={errors.fields.pauseAfterFailures}
          />
        </div>
      ) : null}
    </section>
  );
}

function FormBody({ state, creating }: { state: ScriptFormState; creating: boolean }) {
  const { form, update, errors, files } = state;
  const options = useScopeOptions(true);
  return (
    <>
      {creating ? <BasicsFields form={form} update={update} errors={errors} /> : null}
      <TriggerFields form={form} update={update} errors={errors} creating={creating} />
      <ScriptScopeFields
        form={form}
        update={update}
        options={options}
        error={errors.fields.scope}
        preview={state.scopePreview}
        previewPending={state.previewPending}
        onPreview={state.runPreview}
      />
      <FormField id="container-script-body" label="脚本" hint="以 root 身份在容器内执行" error={errors.fields.script}>
        <Textarea
          id="container-script-body"
          className="min-h-[240px] font-mono text-xs"
          spellCheck={false}
          value={form.script}
          onChange={(event) => update({ script: event.target.value })}
        />
      </FormField>
      <ScriptFilesField
        rows={form.files}
        rowErrors={errors.files}
        error={errors.fields.files}
        onAdd={(picked) => files.addFiles(picked, form)}
        onChange={(key, changes) => files.patchRow(key, changes)}
        onReplace={(key, file) => files.upload(key, file)}
        onRemove={(key) => update({ files: form.files.filter((row) => row.key !== key) })}
      />
      <AdvancedFields form={form} update={update} errors={errors} />
      <FormField id="container-script-note" label="版本说明（可选）">
        <Input
          id="container-script-note"
          value={form.note}
          maxLength={512}
          placeholder="这个版本改了什么"
          onChange={(event) => update({ note: event.target.value })}
        />
      </FormField>
    </>
  );
}

function ConfirmView({ state, title }: { state: ScriptFormState; title: string }) {
  const preview = state.confirming;
  if (!preview) return null;
  return (
    <div className="space-y-3" data-testid="container-script-confirm">
      <p className="text-sm font-medium">{title}</p>
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {confirmLines(state.form, preview).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <ScopePreviewSummary preview={preview} />
      {state.form.applyNow && preview.total > 0 ? (
        <Alert variant="warning">
          <TriangleAlert className="h-4 w-4" />
          <AlertDescription className="text-xs">脚本以 root 身份在这些容器内执行，确认前请再检查一遍脚本内容。</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

/** Create a container script, or publish a new version of one: the same form, prefilled for a publish. */
export function ScriptFormDialog(args: ScriptFormArgs) {
  const state = useScriptForm(args);
  const creating = args.target.kind === 'create';
  const nextVersion = args.target.kind === 'publish' ? args.target.script.current.version + 1 : 1;
  const title = creating ? '新建容器脚本' : `发布新版本 · ${args.target.kind === 'publish' ? args.target.script.name : ''}`;
  const confirmTitle = creating ? `创建「${state.form.name.trim()}」并发布 v1` : `发布 v${nextVersion}`;
  const close = (next: boolean) => { if (!state.sending) args.onOpenChange(next); };
  return (
    <Dialog open={args.open} onOpenChange={close}>
      <DialogContent className="sm:max-w-3xl" data-testid="container-script-form">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {creating
              ? '脚本以 root 身份在范围内的容器里执行。每次发布都是一个不可修改的新版本。'
              : `发布为 v${nextVersion}；已发布的版本不会改变。`}
          </DialogDescription>
        </DialogHeader>
        {state.confirming ? <ConfirmView state={state} title={confirmTitle} /> : <FormBody state={state} creating={creating} />}
        {state.serverError ?? state.errors.fields.form ? (
          <p className="text-sm text-destructive">{state.serverError ?? state.errors.fields.form}</p>
        ) : null}
        <DialogFooter>
          {state.confirming ? (
            <>
              <Button variant="outline" onClick={state.cancelConfirm} disabled={state.sending}>返回修改</Button>
              <Button onClick={state.confirm} disabled={state.sending} data-testid="container-script-confirm-submit">
                {state.sending ? '提交中...' : creating ? '确认创建' : '确认发布'}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => close(false)}>取消</Button>
              <Button onClick={state.submit} disabled={state.previewPending || state.uploading}>
                {state.uploading ? '等待上传...' : state.previewPending ? '检查范围...' : '下一步'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
