import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Capability,
  type CertificateRotationDto,
  type IncusClientCertificateDto,
} from '@nyabase/common';
import { api } from '../../lib/api.js';
import { errorMessage } from '../../lib/api-error.js';
import { certificateStatePending, certificateTrustPending } from '../../lib/in-progress.js';
import { queryKeys } from '../../lib/query-keys.js';
import { refetchWhileInProgress } from '../../lib/query-lifecycle.js';
import { toast } from '../../hooks/use-toast.js';
import { useAuthStore } from '../../store/auth.js';
import { CertificateCard } from './certificate-card.js';

/**
 * The control plane's Incus client certificate. It is one certificate shared
 * by every server, so it lives on the server list rather than inside any
 * single server.
 */
export function ClientCertificatePanel({ serverNames }: { serverNames: ReadonlyMap<string, string> }) {
  const queryClient = useQueryClient();
  const [rotateOpen, setRotateOpen] = useState(false);
  const capabilities = useAuthStore((state) => state.user?.capabilities ?? []);
  const canManageCertificates = capabilities.includes(Capability.ManageCertificates);
  const canViewCertificate = canManageCertificates || capabilities.includes(Capability.ManageServers);

  const certificateQuery = useQuery({
    queryKey: queryKeys.certificate,
    queryFn: () => api.get<IncusClientCertificateDto>('/admin/incus-client-certificate'),
    enabled: canViewCertificate,
    refetchInterval: (query) => refetchWhileInProgress(query.state, {
      steadyIntervalMs: false,
      isSettled: (certificate) => !certificateStatePending(certificate.state)
        && certificate.servers.every((trust) => !certificateTrustPending(trust.trustState)),
    }),
  });

  const rotate = useMutation({
    mutationFn: () => api.post<CertificateRotationDto>('/admin/incus-client-certificate/rotate', {
      expectedGeneration: certificateQuery.data?.generation ?? 0,
    }),
    onSuccess: () => {
      setRotateOpen(false);
      toast({ title: '已开始轮换客户端证书', description: '各服务器会依次完成信任与切换。' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.certificate });
      void queryClient.invalidateQueries({ queryKey: queryKeys.servers.admin });
    },
    onError: (error) => toast({ title: '证书轮换失败', description: errorMessage(error), variant: 'destructive' }),
  });

  return (
    <CertificateCard
      serverNames={serverNames}
      canViewCertificate={canViewCertificate}
      canManageCertificates={canManageCertificates}
      certificateQuery={canViewCertificate ? certificateQuery : undefined}
      rotatePending={rotate.isPending}
      rotateOpen={rotateOpen}
      onRotateOpenChange={setRotateOpen}
      onRotate={() => rotate.mutate()}
    />
  );
}
