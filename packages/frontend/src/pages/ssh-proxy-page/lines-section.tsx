import { useEffect, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  SSH_PROXY_LINE_HINT_MAX_LENGTH,
  formatSshAddress,
  zCreateSshProxyLineRequest,
  type SshProxyLineDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Hint } from '../../components/ui/hint.js';
import { Input } from '../../components/ui/input.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { ConfirmDialog } from '../../components/layout/confirm-dialog.js';
import { EmptyState } from '../../components/layout/empty-state.js';
import { FormField } from '../../components/layout/form-field.js';
import { QueryView } from '../../components/layout/query-view.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { toast } from '../../hooks/use-toast.js';
import { queryKeys } from '../../lib/query-keys.js';

/**
 * The SSH proxy's public addresses. Each is an `ssh -J` tab on every
 * container's SSH card, in this order; the first is the default route of the
 * one-time client setup.
 */
export function SshProxyLinesSection({ query }: { query: UseQueryResult<SshProxyLineDto[]> }) {
  const queryClient = useQueryClient();
  const [editor, setEditor] = useState<{ line: SshProxyLineDto | null } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SshProxyLineDto | null>(null);
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.put<SshProxyLineDto[]>('/admin/ssh-proxy/lines/order', { ids }),
    onSuccess: (lines) => queryClient.setQueryData(queryKeys.sshProxy.lines, lines),
    onError: (error) => {
      toast({ title: '调整顺序失败', description: errorMessage(error, '操作失败'), variant: 'destructive' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sshProxy.lines });
    },
  });
  const deleteLine = useMutation({
    mutationFn: (id: string) => api.delete<void>(`/admin/ssh-proxy/lines/${id}`),
    onSuccess: () => {
      toast({ title: '线路已删除' });
      setDeleteTarget(null);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sshProxy.lines });
    },
    onError: (error) => {
      toast({ title: '删除失败', description: errorMessage(error, '操作失败'), variant: 'destructive' });
    },
  });
  const addButton = (
    <Button size="sm" onClick={() => setEditor({ line: null })} data-testid="ssh-proxy-line-add">
      <Plus className="h-4 w-4" />新增线路
    </Button>
  );
  const move = (lines: SshProxyLineDto[], index: number, offset: -1 | 1) => {
    const ids = lines.map((line) => line.id);
    [ids[index], ids[index + offset]] = [ids[index + offset]!, ids[index]!];
    reorder.mutate(ids);
  };

  return (
    <>
      <QueryView
        query={query}
        resourceName="线路"
        loadingLabel="加载线路..."
        showEmpty={query.data?.length === 0}
        empty={<EmptyState title="尚未添加线路" description="添加后，用户才能经 SSH 代理登录容器。" action={addButton} />}
      >
        {(lines) => (
          <SectionCard title="线路" actions={addButton} flush testId="ssh-proxy-lines">
            <Table className="min-w-[640px]">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-20">顺序</TableHead>
                  <TableHead>名称</TableHead>
                  <TableHead>地址</TableHead>
                  <TableHead>提示</TableHead>
                  <TableHead className="text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line, index) => (
                  <TableRow key={line.id} data-testid="ssh-proxy-line">
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label="上移"
                          disabled={index === 0 || reorder.isPending}
                          onClick={() => move(lines, index, -1)}
                        >
                          <ArrowUp className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          aria-label="下移"
                          disabled={index === lines.length - 1 || reorder.isPending}
                          onClick={() => move(lines, index, 1)}
                        >
                          <ArrowDown className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className="inline-flex items-center gap-2">
                        {line.name}
                        {index === 0 ? (
                          <Hint content="一次性 SSH 配置默认经由这条线路">
                            <span tabIndex={0} className="inline-flex rounded-md">
                              <Badge variant="secondary">默认</Badge>
                            </span>
                          </Hint>
                        ) : null}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-sm">
                      {formatSshAddress(line)}
                    </TableCell>
                    <TableCell className="max-w-xs whitespace-normal text-sm text-muted-foreground">{line.hint ?? '—'}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setEditor({ line })}>
                          <Pencil className="h-3.5 w-3.5" />编辑
                        </Button>
                        <Button size="sm" variant="ghost-destructive" onClick={() => setDeleteTarget(line)}>
                          <Trash2 className="h-3.5 w-3.5" />删除
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </SectionCard>
        )}
      </QueryView>
      <SshProxyLineEditorDialog
        open={editor !== null}
        onOpenChange={(open) => { if (!open) setEditor(null); }}
        line={editor?.line ?? null}
      />
      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="删除线路？"
        description={`用户将不再看到「${deleteTarget?.name ?? ''}」；已按它写好的 SSH 配置会失效。`}
        confirmLabel="确认删除"
        pendingLabel="删除中..."
        pending={deleteLine.isPending}
        testId="ssh-proxy-line-delete-confirm"
        onConfirm={() => { if (deleteTarget) deleteLine.mutate(deleteTarget.id); }}
      />
    </>
  );
}

const EMPTY_FORM = { name: '', host: '', port: '2222', hint: '' };

/** Create a line (`line` null) or edit one; every field is sent, the server keeps what did not change. */
function SshProxyLineEditorDialog({
  open,
  onOpenChange,
  line,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  line: SshProxyLineDto | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(line ? { name: line.name, host: line.host, port: String(line.port), hint: line.hint ?? '' } : EMPTY_FORM);
    setError(null);
  }, [open, line]);

  const save = useMutation({
    mutationFn: (body: unknown) => (line
      ? api.patch<SshProxyLineDto>(`/admin/ssh-proxy/lines/${line.id}`, body)
      : api.post<SshProxyLineDto>('/admin/ssh-proxy/lines', body)),
    onSuccess: () => {
      toast({ title: line ? '线路已更新' : '线路已添加' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sshProxy.lines });
      onOpenChange(false);
    },
    onError: (mutationError) => setError(errorMessage(mutationError, '保存失败')),
  });

  const submit = () => {
    const parsed = zCreateSshProxyLineRequest.safeParse({
      name: form.name,
      host: form.host,
      port: Number(form.port),
      hint: form.hint,
    });
    if (!parsed.success) {
      setError(lineInputProblem(parsed.error.issues[0]?.path[0]));
      return;
    }
    save.mutate(parsed.data);
  };
  const update = (field: keyof typeof EMPTY_FORM) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((current) => ({ ...current, [field]: event.target.value }));
    setError(null);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="ssh-proxy-line-editor">
        <DialogHeader>
          <DialogTitle>{line ? '编辑线路' : '新增线路'}</DialogTitle>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => { event.preventDefault(); submit(); }}
        >
          <FormField id="ssh-line-name" label="名称">
            <Input id="ssh-line-name" value={form.name} placeholder="校园网" onChange={update('name')} />
          </FormField>
          <div className="grid grid-cols-[1fr_7rem] gap-3">
            <FormField id="ssh-line-host" label="主机">
              <Input id="ssh-line-host" className="font-mono" value={form.host} placeholder="ssh.example.com" onChange={update('host')} />
            </FormField>
            <FormField id="ssh-line-port" label="端口">
              <Input id="ssh-line-port" className="font-mono" inputMode="numeric" value={form.port} onChange={update('port')} />
            </FormField>
          </div>
          <FormField id="ssh-line-hint" label="提示（可选）" hint="显示在容器的 SSH 登录卡片上">
            <Input
              id="ssh-line-hint"
              value={form.hint}
              maxLength={SSH_PROXY_LINE_HINT_MAX_LENGTH}
              placeholder="仅限校内网络"
              onChange={update('hint')}
            />
          </FormField>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>取消</Button>
            <Button type="submit" disabled={save.isPending}>{save.isPending ? '保存中...' : '保存'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function lineInputProblem(field: unknown): string {
  switch (field) {
    case 'name': return '名称不能为空，最多 8 个汉字或 16 个字符';
    case 'host': return '主机须为域名或 IP 地址';
    case 'port': return '端口须为 1–65535';
    case 'hint': return '提示须为单行文字';
    default: return '请检查线路参数';
  }
}
