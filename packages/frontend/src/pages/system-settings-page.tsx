import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Save } from 'lucide-react';
import type { SystemSettingsDto } from '@nyabase/common';
import { api } from '../lib/api.js';
import { Button } from '../components/ui/button.js';
import { Page, PageHeader } from '../components/layout/page-header.js';
import { QueryView } from '../components/layout/query-view.js';
import { TechnicalId } from '../components/refs/technical-id.js';
import { queryKeys } from '../lib/query-keys.js';
import {
  EditableSettingsSection,
  EffectiveSettingsSection,
} from './system-settings-page/settings-sections.js';
import { useSettingsDraft } from './system-settings-page/use-settings-draft.js';

export default function SystemSettingsPage() {
  const settingsQuery = useQuery({
    queryKey: queryKeys.systemSettings,
    queryFn: () => api.get<SystemSettingsDto>('/admin/system-settings'),
  });
  const { data, isFetching, refetch } = settingsQuery;
  const draft = useSettingsDraft(settingsQuery);

  return (
    <Page>
      <PageHeader
        title="系统设置"
        description={data?.configFile
          ? <TechnicalId label="配置路径" value={data.configFile} kind="text" />
          : '配置路径尚未加载'}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              onClick={() => {
                if ((draft.draftState?.dirtyFields.size ?? 0) > 0
                  && !window.confirm('刷新会保留本地修改，并标记与服务器同时修改的冲突。继续刷新？')) return;
                void refetch();
              }}
              disabled={isFetching}
              title="刷新服务器配置"
            >
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
            <Button type="submit" form="system-settings-form" disabled={!draft.canSave}>
              <Save className="h-4 w-4" />
              保存
            </Button>
          </>
        }
      />

      <QueryView
        query={settingsQuery}
        resourceName="系统设置"
        loadingLabel="加载系统设置..."
      >
        {() => (
          <>
            <EditableSettingsSection draft={draft} />
            <EffectiveSettingsSection fields={data?.fields ?? []} />
          </>
        )}
      </QueryView>
    </Page>
  );
}
