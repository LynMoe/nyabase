import { Link } from '@tanstack/react-router';
import { ContainerScriptStatus, type ContainerScriptDto } from '@nyabase/common';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { CountsSummary, ScriptStatusBadge, TriggerBadges } from '../../components/container-scripts/script-badges.js';
import { scopeSummary } from '../../lib/container-scripts.js';
import { cn } from '../../lib/utils.js';

/** The scripts in the order they run on a container (priority), each linking to its page. */
export function ContainerScriptsTable({ scripts }: { scripts: ContainerScriptDto[] }) {
  return (
    <SectionCard flush testId="container-scripts-table">
      <Table className="min-w-[960px]">
        <TableHeader>
          <TableRow>
            <TableHead className="w-20">优先级</TableHead>
            <TableHead>名称</TableHead>
            <TableHead>触发</TableHead>
            <TableHead>范围</TableHead>
            <TableHead className="w-16">版本</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>进度</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {scripts.map((script) => (
            <TableRow
              key={script.id}
              className={cn('align-top', script.status === ContainerScriptStatus.Archived && 'text-muted-foreground')}
            >
              <TableCell className="font-mono">{script.priority}</TableCell>
              <TableCell className="max-w-[18rem] whitespace-normal">
                <Link
                  to="/container-scripts/$scriptId"
                  params={{ scriptId: script.id }}
                  search={{ tab: 'targets' }}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {script.name}
                </Link>
                {script.description ? <div className="text-xs text-muted-foreground">{script.description}</div> : null}
              </TableCell>
              <TableCell><TriggerBadges script={script} version={script.current} /></TableCell>
              <TableCell className="max-w-[16rem] whitespace-normal text-sm">{scopeSummary(script.current.scope)}</TableCell>
              <TableCell className="font-mono text-sm">v{script.current.version}</TableCell>
              <TableCell><ScriptStatusBadge script={script} /></TableCell>
              <TableCell className="max-w-[20rem] whitespace-normal"><CountsSummary counts={script.counts} /></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </SectionCard>
  );
}
