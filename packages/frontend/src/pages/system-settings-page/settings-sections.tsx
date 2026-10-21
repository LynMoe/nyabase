import type { SystemSettingFieldDto } from '@nyabase/common';
import { Alert, AlertDescription } from '../../components/ui/alert.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Input } from '../../components/ui/input.js';
import { Label } from '../../components/ui/label.js';
import { Switch } from '../../components/ui/switch.js';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table.js';
import { TechnicalId } from '../../components/refs/technical-id.js';
import {
  editRevisionedServerBackedDraft,
  resolveRevisionedDraftConflicts,
} from '../../lib/server-backed-draft.js';
import {
  SOURCE_LABELS,
  displayValue,
  fieldDescription,
  fieldLabel,
  groupFields,
} from './field-labels.js';
import type { SettingsDraft } from './use-settings-draft.js';

function sourceBadgeVariant(source: SystemSettingFieldDto['source']) {
  return source === 'env' ? 'warning' : source === 'yaml' ? 'secondary' : 'outline';
}

function SettingInput({
  field,
  value,
  onChange,
}: {
  field: SystemSettingFieldDto;
  value: string;
  onChange: (value: string) => void;
}) {
  const disabled = field.source === 'env';
  if (field.valueKind === 'boolean') {
    return (
      <Switch
        id={`setting-${field.key}`}
        checked={value === 'true'}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
      />
    );
  }
  return (
    <Input
      id={`setting-${field.key}`}
      value={value}
      type={field.valueKind === 'number' ? 'number' : 'text'}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** The editable settings form, with the banner offered when the server changed fields under local edits. */
export function EditableSettingsSection({ draft }: { draft: SettingsDraft }) {
  const { draftState, setDraftState, editableFields, parsedChanges } = draft;
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">配置修改</h2>
      {draft.hasConflicts && draftState && (
        <Alert>
          <AlertDescription className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <span>服务器同时修改了 {draftState.conflictFields.size} 个字段；本地输入已保留，请选择处理方式。</span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setDraftState(resolveRevisionedDraftConflicts(draftState, 'use-server'))}>
                使用服务器值
              </Button>
              <Button size="sm" onClick={() => setDraftState(resolveRevisionedDraftConflicts(draftState, 'keep-local'))}>
                保留本地并覆盖
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}
      <form
        id="system-settings-form"
        className="overflow-hidden rounded-lg border border-border bg-background"
        onSubmit={(event) => {
          event.preventDefault();
          draft.submit();
        }}
      >
        {editableFields.map((field) => (
          <div key={field.key} className="grid gap-3 border-t border-border p-4 first:border-t-0 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,28rem)] lg:items-start">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor={`setting-${field.key}`} className="text-sm font-medium">
                  {fieldLabel(field)}
                </Label>
                <Badge variant={sourceBadgeVariant(field.source)}>
                  {SOURCE_LABELS[field.source]}
                </Badge>
                {draftState?.conflictFields.has(field.key) && <Badge variant="warning">服务器冲突</Badge>}
                {field.restartRequired && <Badge variant="outline">需要重启</Badge>}
              </div>
              <div className="mt-1">
                <TechnicalId label="配置路径" value={field.yamlPath} kind="text" />
              </div>
              <p className="mt-2 text-xs leading-5 text-muted-foreground">{fieldDescription(field)}</p>
            </div>
            <SettingInput
              field={field}
              value={draftState?.values[field.key] ?? ''}
              onChange={(value) => setDraftState((current) => current
                ? editRevisionedServerBackedDraft(current, field.key, value)
                : current)}
            />
            {parsedChanges.errors[field.key] && (
              <p className="text-xs text-destructive lg:col-start-2">{parsedChanges.errors[field.key]}</p>
            )}
          </div>
        ))}
      </form>
    </section>
  );
}

/** Every setting with its effective value and where that value came from. */
export function EffectiveSettingsSection({ fields }: { fields: SystemSettingFieldDto[] }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold text-foreground">有效配置</h2>
      <div className="space-y-4">
        {groupFields(fields).map((group) => (
          <div key={group.key} className="overflow-hidden rounded-lg border border-border bg-background">
            <div className="flex items-center justify-between gap-3 border-b border-border bg-muted/40 px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
                <p className="mt-0.5 font-mono text-xs text-muted-foreground">{group.key}.*</p>
              </div>
              <Badge variant="outline">{group.fields.length} 项</Badge>
            </div>
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/30 hover:bg-muted/30">
                  <TableHead>配置项</TableHead>
                  <TableHead>有效值</TableHead>
                  <TableHead>来源</TableHead>
                  <TableHead>配置文件值</TableHead>
                  <TableHead>环境变量</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.fields.map((field) => (
                  <TableRow key={field.key}>
                    <TableCell>
                      <div className="font-mono text-xs text-foreground">{field.key}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span>{fieldLabel(field)}</span>
                        {field.restartRequired && <Badge variant="outline">需要重启</Badge>}
                      </div>
                    </TableCell>
                    <TableCell className="break-all">{displayValue(field, field.effectiveValue)}</TableCell>
                    <TableCell>
                      <Badge variant={sourceBadgeVariant(field.source)}>
                        {SOURCE_LABELS[field.source]}
                      </Badge>
                    </TableCell>
                    <TableCell className="break-all text-muted-foreground">{displayValue(field, field.yamlValue)}</TableCell>
                    <TableCell className="break-all text-muted-foreground">{field.envValuePresent ? field.env : '-'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </div>
    </section>
  );
}
