import { useState } from 'react';
import { Cpu, Pencil } from 'lucide-react';
import type { ServerCpuDto, ServerDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card.js';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog.js';
import { Input } from '../ui/input.js';
import { Field, FormField } from '../layout/form-field.js';
import { formatCpuList, groupCpuTopology, parseCpuList } from '../../lib/cpu-set.js';
import { useUpdateServer } from '../../lib/server-queries.js';
import { cn } from '../../lib/utils.js';

const RESERVED_NOTE = '保留的逻辑 CPU 留给宿主机系统与 Agent，永远不会分配给任何容器；用户的 CPU 组只从其余 CPU 中划分。';

/** Logical CPUs grouped by socket / NUMA node and physical core; reserved ones highlighted. */
function CpuTopologyView({
  topology,
  reserved,
  onToggle,
}: {
  topology: readonly ServerCpuDto[];
  reserved: ReadonlySet<number>;
  onToggle?: (cpu: number) => void;
}) {
  return (
    <div className="space-y-3" data-testid="server-cpu-topology">
      {groupCpuTopology(topology).map((group) => (
        <div key={group.key} className="space-y-1.5">
          <p className="text-xs text-muted-foreground">
            插槽 {group.socket} · NUMA {group.numa} · {group.cores.length} 个物理核
          </p>
          <div className="flex flex-wrap gap-1.5">
            {group.cores.map((core) => (
              <div key={core.core} className="flex gap-0.5 rounded-md border p-0.5" title={`物理核 ${core.core}`}>
                {core.cpus.map((cpu) => {
                  const isReserved = reserved.has(cpu);
                  const className = cn(
                    'min-w-[2rem] rounded px-1.5 py-0.5 text-center font-mono text-xs tabular-nums',
                    isReserved ? 'bg-warning/20 text-warning' : 'bg-muted text-foreground',
                    onToggle && 'cursor-pointer hover:ring-1 hover:ring-ring',
                  );
                  return onToggle ? (
                    <button
                      key={cpu}
                      type="button"
                      className={className}
                      aria-pressed={isReserved}
                      aria-label={`CPU ${cpu}${isReserved ? '（已保留）' : ''}`}
                      onClick={() => onToggle(cpu)}
                    >
                      {cpu}
                    </button>
                  ) : (
                    <span key={cpu} className={className}>{cpu}</span>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ReservedCpusDialog({ server, onClose }: { server: ServerDto; onClose: () => void }) {
  const [text, setText] = useState(() => formatCpuList(server.reservedCpus));
  const update = useUpdateServer(server.id, onClose);
  const parsed = parseCpuList(text);
  const reserved = new Set(parsed.ok ? parsed.cpus : []);
  const known = server.cpuTopology ? new Set(server.cpuTopology.map((cpu) => cpu.id)) : null;
  const unknown = parsed.ok && known ? parsed.cpus.filter((cpu) => !known.has(cpu)) : [];
  const allReserved = parsed.ok && known !== null && known.size > 0 && [...known].every((cpu) => reserved.has(cpu));
  const toggle = (cpu: number) => {
    const next = new Set(reserved);
    if (next.has(cpu)) next.delete(cpu);
    else next.add(cpu);
    setText(formatCpuList([...next]));
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>编辑保留 CPU</DialogTitle>
          <DialogDescription>{RESERVED_NOTE}</DialogDescription>
        </DialogHeader>
        <FormField
          id="server-reserved-cpus"
          label="保留的逻辑 CPU（留空为不保留）"
          hint={unknown.length > 0
            ? `CPU ${formatCpuList(unknown)} 不在已上报的拓扑中`
            : allReserved ? '所有 CPU 都被保留，容器将无 CPU 可用' : '例如 0,1 或 0-1'}
          error={parsed.ok ? undefined : parsed.error}
        >
          <Input
            id="server-reserved-cpus"
            value={text}
            placeholder="0-1"
            className="font-mono"
            aria-invalid={parsed.ok ? undefined : true}
            onChange={(event) => setText(event.target.value)}
          />
        </FormField>
        {server.cpuTopology ? (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">点击 CPU 切换是否保留；同一边框内为同一物理核的超线程。</p>
            <CpuTopologyView topology={server.cpuTopology} reserved={reserved} onToggle={toggle} />
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button
            disabled={!parsed.ok || update.isPending}
            onClick={() => {
              if (!parsed.ok) return;
              update.mutate({ expectedRevision: server.revision, reservedCpus: parsed.cpus });
            }}
          >
            {update.isPending ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reserved logical CPUs of a server and its CPU topology as last reported by the agent. */
export function ReservedCpusCard({ server }: { server: ServerDto }) {
  const [editing, setEditing] = useState(false);
  const reserved = new Set(server.reservedCpus);
  const total = server.cpuTopology?.length ?? null;
  const assignable = server.cpuTopology ? server.cpuTopology.filter((cpu) => !reserved.has(cpu.id)).length : null;
  return (
    <Card data-testid="server-reserved-cpus">
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-base"><Cpu className="h-4 w-4" />CPU 与保留核</CardTitle>
          <CardDescription>{RESERVED_NOTE}</CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" />编辑保留 CPU
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="保留 CPU" value={server.reservedCpus.length > 0 ? formatCpuList(server.reservedCpus) : '无'} mono={server.reservedCpus.length > 0} />
          <Field label="逻辑 CPU 总数" value={total ?? '尚未上报'} />
          <Field label="可分配给容器" value={assignable === null ? '—' : `${assignable} 个`} />
        </div>
        {server.cpuTopology ? (
          <CpuTopologyView topology={server.cpuTopology} reserved={reserved} />
        ) : (
          <p className="text-sm text-muted-foreground">Agent 尚未上报 CPU 拓扑；接入后会在这里按插槽 / NUMA / 物理核显示。</p>
        )}
      </CardContent>
      {editing ? <ReservedCpusDialog server={server} onClose={() => setEditing(false)} /> : null}
    </Card>
  );
}
