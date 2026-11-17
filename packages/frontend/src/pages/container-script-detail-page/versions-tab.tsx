import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ContainerScriptDto,
  ContainerScriptVersionDto,
  ContainerScriptVersionSummaryDto,
} from '@nyabase/common';
import { Badge } from '../../components/ui/badge.js';
import { Button } from '../../components/ui/button.js';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../../components/ui/dialog.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table.js';
import { QueryView } from '../../components/layout/query-view.js';
import { SectionCard } from '../../components/layout/section-card.js';
import { TriggerBadges } from '../../components/container-scripts/script-badges.js';
import { ScriptVersionView } from '../../components/container-scripts/script-version-view.js';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { personLabel, scriptTime } from '../../lib/container-scripts.js';

/** One published version in full, fetched when opened. */
function VersionDialog({
  script,
  version,
  onOpenChange,
}: {
  script: ContainerScriptDto;
  version: number | null;
  onOpenChange: (open: boolean) => void;
}) {
  const versionQuery = useQuery({
    queryKey: queryKeys.containerScripts.version(script.id, version ?? 0),
    queryFn: () => api.get<ContainerScriptVersionDto>(`/admin/container-scripts/${script.id}/versions/${version}`),
    enabled: version !== null,
    // A published version never changes.
    staleTime: Infinity,
  });
  return (
    <Dialog open={version !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl" data-testid="container-script-version-dialog">
        <DialogHeader>
          <DialogTitle>{script.name} · v{version}</DialogTitle>
        </DialogHeader>
        <QueryView query={versionQuery} resourceName="脚本版本" loadingLabel="加载脚本版本...">
          {(loaded) => <ScriptVersionView script={script} version={loaded} />}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

/** 版本: every published version, newest first; a row opens it. */
export function ScriptVersionsTab({ script }: { script: ContainerScriptDto }) {
  const [viewing, setViewing] = useState<number | null>(null);
  const versionsQuery = useQuery({
    queryKey: queryKeys.containerScripts.versions(script.id),
    queryFn: () => api.get<ContainerScriptVersionSummaryDto[]>(`/admin/container-scripts/${script.id}/versions`),
  });
  return (
    <SectionCard flush testId="container-script-versions">
      <QueryView query={versionsQuery} resourceName="脚本版本" loadingLabel="加载脚本版本...">
        {(versions) => (
          <Table className="min-w-[760px]">
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">版本</TableHead>
                <TableHead>说明</TableHead>
                <TableHead>触发</TableHead>
                <TableHead>文件</TableHead>
                <TableHead>发布者</TableHead>
                <TableHead>发布时间</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((version) => (
                <TableRow key={version.version} className="cursor-pointer" onClick={() => setViewing(version.version)}>
                  <TableCell className="font-mono text-sm">
                    v{version.version}
                    {version.version === script.current.version ? <Badge variant="success" className="ml-2">当前</Badge> : null}
                  </TableCell>
                  <TableCell className="max-w-[20rem] whitespace-normal text-sm">
                    {version.note || <span className="text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell><TriggerBadges script={script} version={version} /></TableCell>
                  <TableCell className="tabular-nums">{version.fileCount}</TableCell>
                  <TableCell>{personLabel(version.publishedBy)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{scriptTime(version.publishedAt)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(event) => {
                        event.stopPropagation();
                        setViewing(version.version);
                      }}
                    >
                      查看
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </QueryView>
      <VersionDialog script={script} version={viewing} onOpenChange={(open) => { if (!open) setViewing(null); }} />
    </SectionCard>
  );
}
