import type { RemoteFsMountDto } from '@nyabase/common';

export type RemoteFsType = 'nfs' | 'cephfs';

export interface NfsForm {
  nfsServer: string;
  exportPath: string;
  version: '3' | '4' | '4.1' | '4.2';
}

export interface CephFsForm {
  monHosts: string;
  exportPath: string;
  fsName: string;
  clientName: string;
  secret: string;
}

export interface RemoteFsMountDraft {
  name: string;
  displayName: string;
  description: string;
  type: RemoteFsType;
  options: string;
  serverId: string;
  nfsForm: NfsForm;
  cephForm: CephFsForm;
}

export function createRemoteFsMountDraft(mount?: RemoteFsMountDto): RemoteFsMountDraft {
  const existingNfsParams = mount?.params.type === 'nfs' ? mount.params : null;
  const existingCephParams = mount?.params.type === 'cephfs' ? mount.params : null;
  return {
    name: mount?.name ?? '',
    displayName: mount?.displayName ?? '',
    description: mount?.description ?? '',
    type: (mount?.type as RemoteFsType | undefined) ?? 'nfs',
    options: mount?.options ?? '',
    serverId: mount?.serverIds[0] ?? '',
    nfsForm: {
      nfsServer: existingNfsParams?.nfsServer ?? '',
      exportPath: existingNfsParams?.exportPath ?? '/',
      version: existingNfsParams?.version ?? '4',
    },
    cephForm: {
      monHosts: existingCephParams?.monHosts ?? '',
      exportPath: existingCephParams?.exportPath ?? '/',
      fsName: existingCephParams?.fsName ?? '',
      clientName: existingCephParams?.clientName ?? 'admin',
      // Secrets are write-only and must never survive a dialog lifecycle.
      secret: '',
    },
  };
}
