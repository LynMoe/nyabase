import { useState } from 'react';
import type { ContainerDto } from '@nyabase/common';
import { SectionCard } from '../layout/section-card.js';
import { ListSearch, SegmentedFilter } from '../layout/list-search.js';
import { ContainerTable } from './container-table.js';
import type { ContainerBarAction } from './container-action-bar.js';
import {
  containerStatusOptions,
  filterContainers,
  type ContainerStatusFilter,
} from '../../lib/container-filter.js';

/** Container table with search and a status segment, shared by the user and admin lists. */
export function ContainerList({
  containers,
  admin = false,
  onAction,
}: {
  containers: ContainerDto[];
  admin?: boolean;
  onAction: (action: ContainerBarAction, container: ContainerDto) => void | Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ContainerStatusFilter>('all');
  const visible = filterContainers(containers, query, status);
  const filtered = query.trim() !== '' || status !== 'all';
  return (
    <SectionCard
      flush
      toolbar={(
        <div className="flex flex-wrap items-center justify-between gap-2">
          <SegmentedFilter
            label="按状态筛选"
            value={status}
            onChange={setStatus}
            options={containerStatusOptions(containers)}
          />
          <ListSearch
            value={query}
            onChange={setQuery}
            placeholder={admin ? '搜索名称、所有者、服务器、IP' : '搜索名称、服务器、IP'}
          />
        </div>
      )}
    >
      <ContainerTable
        containers={visible}
        admin={admin}
        showServerColumn
        emptyLabel={filtered ? '没有符合条件的容器' : '暂无容器'}
        onAction={onAction}
      />
    </SectionCard>
  );
}
