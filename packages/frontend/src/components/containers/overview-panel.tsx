import { useState } from 'react';
import type {
  ContainerDto,
  GpuGrant,
  ListScope,
  PerformanceSelfResponse,
  PatchContainerLimitsRequest,
} from '@nyabase/common';
import { useAuthStore } from '../../store/auth.js';
import { useMySshKeys } from '../../hooks/use-my-ssh-keys.js';
import { LimitsDialog } from './spec-panel.js';
import { SshConfigDialog } from './overview-panel/ssh-config-dialog.js';
import { SshLoginCard } from './overview-panel/ssh-login-card.js';
import { SpecCard, UsageCard } from './overview-panel/spec-and-usage-cards.js';
import { useSshLogin } from './overview-panel/use-ssh-login.js';

export function OverviewPanel({
  container,
  scope,
  gpuEnabled,
  gpuGrant,
  onRepairSsh,
  repairPending,
  onLimits,
  limitsPending,
  onGpuSubmit,
  gpuPending,
  occupancy,
  occupancyDenied,
}: {
  container: ContainerDto;
  scope: ListScope;
  gpuEnabled: boolean;
  gpuGrant: GpuGrant | null;
  onRepairSsh: () => void;
  repairPending: boolean;
  onLimits: (body: PatchContainerLimitsRequest) => Promise<unknown>;
  limitsPending: boolean;
  onGpuSubmit: (pciAddresses: string[]) => Promise<unknown>;
  gpuPending: boolean;
  occupancy?: PerformanceSelfResponse;
  occupancyDenied?: boolean;
}) {
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const authUser = useAuthStore((state) => state.user);
  const admin = scope === 'all';
  const ownContainer = !admin || (authUser !== null && container.ownerId === authUser.id);
  const sshKeys = useMySshKeys(ownContainer);
  const login = useSshLogin(container);

  return (
    <div className="space-y-4" data-testid="container-overview">
      <SshLoginCard
        container={container}
        login={login}
        showKeyNotice={ownContainer && sshKeys.missing}
        repairPending={repairPending}
        onRepairSsh={onRepairSsh}
        onShowConfig={() => setConfigOpen(true)}
      />
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <SpecCard container={container} scope={scope} onEdit={() => setLimitsOpen(true)} />
        <UsageCard
          containerId={container.id}
          admin={admin}
          occupancy={occupancy}
          occupancyDenied={occupancyDenied}
        />
      </div>
      <SshConfigDialog
        open={configOpen}
        onOpenChange={setConfigOpen}
        containerName={container.name}
        login={login}
      />
      {limitsOpen ? (
        <LimitsDialog
          container={container}
          scope={scope}
          gpuEnabled={gpuEnabled}
          gpuGrant={gpuGrant}
          pending={limitsPending}
          gpuPending={gpuPending}
          onLimits={onLimits}
          onGpuSubmit={onGpuSubmit}
          onOpenChange={(open) => { if (!open) setLimitsOpen(false); }}
        />
      ) : null}
    </div>
  );
}
