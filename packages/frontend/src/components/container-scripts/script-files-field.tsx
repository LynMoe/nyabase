import { useRef } from 'react';
import { Loader2, Plus, Trash2, Upload } from 'lucide-react';
import {
  CONTAINER_SCRIPT_MAX_FILES,
  CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES,
  ContainerScriptFileOwner,
} from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Input } from '../ui/input.js';
import { Label } from '../ui/label.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select.js';
import { cn, formatBytes } from '../../lib/utils.js';
import { filesTotalBytes, installPathProblem, type ScriptFileRow } from '../../lib/container-script-form.js';
import { fileOwnerLabel, SCRIPT_FILE_LIMIT_TEXT } from '../../lib/container-scripts.js';

const OWNERS = [ContainerScriptFileOwner.Root, ContainerScriptFileOwner.LoginUser] as const;

/** A hidden file input behind a button. */
function FilePickButton({
  label,
  multiple = false,
  onPick,
  disabled = false,
  variant = 'outline',
}: {
  label: string;
  multiple?: boolean;
  onPick: (files: File[]) => void;
  disabled?: boolean;
  variant?: 'outline' | 'ghost';
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        className="hidden"
        multiple={multiple}
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = '';
          if (files.length > 0) onPick(files);
        }}
      />
      <Button type="button" size="sm" variant={variant} disabled={disabled} onClick={() => input.current?.click()}>
        {multiple ? <Plus className="h-4 w-4" /> : <Upload className="h-4 w-4" />}{label}
      </Button>
    </>
  );
}

function FileSize({ row }: { row: ScriptFileRow }) {
  if (row.uploading) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />上传中{row.sizeBytes !== null ? ` · ${formatBytes(row.sizeBytes)}` : ''}
      </span>
    );
  }
  if (!row.sha256) return <span className="text-xs text-destructive">未上传</span>;
  return <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(row.sizeBytes ?? 0)}</span>;
}

function FileRowEditor({
  row,
  error,
  onChange,
  onReplace,
  onRemove,
}: {
  row: ScriptFileRow;
  error?: string;
  onChange: (changes: Partial<ScriptFileRow>) => void;
  onReplace: (file: File) => void;
  onRemove: () => void;
}) {
  const id = `container-script-file-${row.key}`;
  const installed = row.path.trim().length > 0;
  const pathProblem = installed ? installPathProblem(row.path.trim()) : null;
  return (
    <div className={cn('space-y-2 rounded-md border p-3', error && 'border-destructive/60')} data-testid="container-script-file-row">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-name`} className="text-xs">名称</Label>
          <Input
            id={`${id}-name`}
            className="h-8 font-mono"
            value={row.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-path`} className="text-xs">安装路径（可选）</Label>
          <Input
            id={`${id}-path`}
            className="h-8 font-mono"
            value={row.path}
            placeholder="留空：只放在 $NYABASE_FILES_DIR"
            aria-invalid={pathProblem ? true : undefined}
            onChange={(event) => onChange({ path: event.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-mode`} className="text-xs">权限</Label>
          <Input
            id={`${id}-mode`}
            className="h-8 w-20 font-mono"
            value={row.mode}
            disabled={!installed}
            onChange={(event) => onChange({ mode: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${id}-owner`} className="text-xs">属主</Label>
          <Select
            value={row.owner}
            disabled={!installed}
            onValueChange={(value) => onChange({ owner: value as ContainerScriptFileOwner })}
          >
            <SelectTrigger id={`${id}-owner`} className="h-8 w-28"><SelectValue /></SelectTrigger>
            <SelectContent>
              {OWNERS.map((owner) => <SelectItem key={owner} value={owner}>{fileOwnerLabel(owner)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <FileSize row={row} />
          <FilePickButton label="替换" variant="ghost" onPick={([file]) => { if (file) onReplace(file); }} disabled={row.uploading} />
          <Button type="button" size="sm" variant="ghost-destructive" onClick={onRemove} aria-label={`删除文件 ${row.name}`}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {error ?? pathProblem ? <p className="text-xs text-destructive">{error ?? pathProblem}</p> : null}
    </div>
  );
}

/** 文件: uploaded once (by content), copied to $NYABASE_FILES_DIR and optionally installed at a path. */
export function ScriptFilesField({
  rows,
  rowErrors,
  error,
  onAdd,
  onChange,
  onReplace,
  onRemove,
}: {
  rows: ScriptFileRow[];
  rowErrors: Record<string, string>;
  error?: string;
  onAdd: (files: File[]) => void;
  onChange: (key: string, changes: Partial<ScriptFileRow>) => void;
  onReplace: (key: string, file: File) => void;
  onRemove: (key: string) => void;
}) {
  const total = filesTotalBytes(rows);
  const overTotal = total > CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES;
  return (
    <section className="space-y-2 rounded-md border p-3" data-testid="container-script-files">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium">文件</p>
          <p className="text-xs text-muted-foreground">
            脚本运行时位于 <span className="font-mono">$NYABASE_FILES_DIR/&lt;名称&gt;</span>；填了安装路径的会在脚本开始前装到该位置。
          </p>
        </div>
        <FilePickButton label="添加文件" multiple onPick={onAdd} disabled={rows.length >= CONTAINER_SCRIPT_MAX_FILES} />
      </div>
      {rows.map((row) => (
        <FileRowEditor
          key={row.key}
          row={row}
          error={rowErrors[row.key]}
          onChange={(changes) => onChange(row.key, changes)}
          onReplace={(file) => onReplace(row.key, file)}
          onRemove={() => onRemove(row.key)}
        />
      ))}
      <p className={cn('text-xs text-muted-foreground', overTotal && 'text-destructive')}>
        {rows.length} / {CONTAINER_SCRIPT_MAX_FILES} 个，合计 {formatBytes(total)} / {formatBytes(CONTAINER_SCRIPT_MAX_FILES_TOTAL_BYTES)}（{SCRIPT_FILE_LIMIT_TEXT}）
      </p>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </section>
  );
}
