import type { ReactNode } from 'react';
import { RotateCw } from 'lucide-react';
import {
  CertificateState,
  CertificateTrustState,
  type IncusClientCertificateDto,
} from '@nyabase/common';
import { ConfirmDialog } from '../layout/confirm-dialog.js';
import { QueryView, type QueryLike } from '../layout/query-view.js';
import { StatusBadge } from '../layout/status-badge.js';
import { ResourceIntentFailures } from '../intents/resource-intent-failures.js';
import { Button } from '../ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card.js';
import {
  certExpiryWarning,
  formatCertRemainingLabel,
} from '../../lib/cert-expiry.js';
import { certificateStatePending, certificateTrustPending } from '../../lib/in-progress.js';
import { relativeTime } from '../../lib/utils.js';
import { ResourceRef } from '../refs/resource-ref.js';
import { TechnicalId } from '../refs/technical-id.js';

export function CertificateCard({
  serverId,
  serverName,
  canViewCertificate,
  canManageCertificates,
  certificateQuery,
  rotatePending,
  rotateOpen,
  onRotateOpenChange,
  onRotate,
}: {
  serverId: string;
  serverName?: string;
  canViewCertificate: boolean;
  canManageCertificates: boolean;
  certificateQuery?: QueryLike<IncusClientCertificateDto>;
  rotatePending: boolean;
  rotateOpen: boolean;
  onRotateOpenChange: (open: boolean) => void;
  onRotate: () => void;
}) {
  const certificate = certificateQuery?.data;

  return (
    <Card data-testid="certificate-rotation">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><RotateCw className="h-4 w-4" />Incus 客户端证书</CardTitle>
          </div>
          {canManageCertificates ? (
            <Button
              variant="outline"
              disabled={rotatePending || !certificate}
              onClick={() => onRotateOpenChange(true)}
            >
              <RotateCw className={rotatePending ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />轮换证书
            </Button>
          ) : (
            <Button variant="outline" disabled>
              <RotateCw className="h-4 w-4" />轮换证书
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!canViewCertificate || !certificateQuery ? (
          <p className="text-sm text-muted-foreground" data-testid="certificate-rotate-gated">
            可以查看服务器，但查看客户端证书需要「管理服务器」或「管理证书」权限。
          </p>
        ) : (
          <>
            {!canManageCertificates && certificate ? (
              <p className="text-xs text-muted-foreground" data-testid="certificate-rotate-gated">
                可以查看证书状态，但轮换需要「管理证书」权限。
              </p>
            ) : null}
            <QueryView
              query={certificateQuery}
              resourceName="Incus 客户端证书"
              loadingLabel="加载证书..."
              showEmpty={!certificateQuery.data}
              empty={<p className="text-sm text-muted-foreground">暂无客户端证书。</p>}
            >
              {(loaded) => (
                <CertificateDetails
                  serverId={serverId}
                  serverName={serverName}
                  certificate={loaded}
                  showIntentFailures={canManageCertificates}
                />
              )}
            </QueryView>
          </>
        )}
      </CardContent>
      {canManageCertificates ? (
        <ConfirmDialog
          open={rotateOpen}
          onOpenChange={onRotateOpenChange}
          title="轮换 Incus 客户端证书？"
          description="轮换会生成新的客户端证书收敛意图，各服务器需重新完成信任校验。期间可能短暂影响与 Incus 的互信。"
          confirmLabel="确认轮换"
          pendingLabel="确认轮换"
          pending={rotatePending}
          onConfirm={onRotate}
        />
      ) : null}
    </Card>
  );
}

function InfoRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted-foreground">{label}</p>
      {typeof value === 'string' ? <p className="break-all text-sm">{value}</p> : <div className="mt-1">{value}</div>}
    </div>
  );
}

function certificateStateVariant(state: string): 'success' | 'secondary' | 'destructive' | 'warning' {
  if (state === CertificateState.Active) return 'success';
  if (state === CertificateState.Failed) return 'destructive';
  if (state === CertificateState.Staged) return 'warning';
  return 'secondary';
}

function CertificateDetails({
  serverId,
  serverName,
  certificate,
  showIntentFailures,
}: {
  serverId: string;
  serverName?: string;
  certificate: IncusClientCertificateDto;
  showIntentFailures: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <InfoRow label="代次" value={String(certificate.generation)} />
        <InfoRow label="指纹" value={<TechnicalId label="指纹" value={certificate.fingerprint} />} />
        <InfoRow
          label="状态"
          value={(
            <StatusBadge
              label={certificate.state}
              pending={certificateStatePending(certificate.state)}
              variant={certificateStateVariant(certificate.state)}
            />
          )}
        />
        <InfoRow label="生效时间" value={new Date(certificate.notBefore).toLocaleString()} />
        <InfoRow label="过期时间" value={new Date(certificate.notAfter).toLocaleString()} />
        <InfoRow
          label="剩余有效期"
          value={formatCertRemainingLabel(certificate.notAfter)}
        />
      </div>
      {certExpiryWarning(certificate.notAfter) && (
        <p className="text-sm text-destructive">
          {certExpiryWarning(certificate.notAfter) === 'expired'
            ? `客户端证书已于 ${new Date(certificate.notAfter).toLocaleDateString()} 过期，请轮换`
            : `客户端证书将于 ${new Date(certificate.notAfter).toLocaleDateString()} 过期，请轮换`}
        </p>
      )}
      {showIntentFailures && (
        <ResourceIntentFailures
          listPath="/admin/intents?kind=certificate.rotate"
          admin
        />
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {certificate.servers.map((trust) => (
          <CertificateTrustWizard
            key={trust.serverId}
            currentServerId={serverId}
            currentServerName={serverName}
            trust={trust}
          />
        ))}
      </div>
    </div>
  );
}

function CertificateTrustWizard({
  currentServerId,
  currentServerName,
  trust,
}: {
  currentServerId: string;
  currentServerName?: string;
  trust: IncusClientCertificateDto['servers'][number];
}) {
  const steps = [
    { key: 'trust', label: '信任新证书' },
    { key: 'switch', label: '切换' },
    { key: 'revoke', label: '撤销旧证书' },
  ] as const;
  const completed = trustWizardCompletedSteps(trust.trustState);
  const failedRevoke = trust.trustState === CertificateTrustState.CleanupFailed;
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="certificate-trust-wizard">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p>
            <ResourceRef
              kind="server"
              id={trust.serverId}
              name={trust.serverId === currentServerId ? currentServerName : undefined}
            />
          </p>
          <p className="text-xs text-muted-foreground">{trust.lastError ?? relativeTime(trust.observedAt)}</p>
        </div>
        <StatusBadge
          label={certTrustStateLabel(trust.trustState)}
          pending={certificateTrustPending(trust.trustState)}
          variant={
            trust.serverId === currentServerId && trust.trustState === CertificateTrustState.Verified
              ? 'success'
              : trust.trustState === CertificateTrustState.Revoked
                ? 'success'
                : trust.trustState === CertificateTrustState.CleanupFailed
                  ? 'destructive'
                  : 'secondary'
          }
        />
      </div>
      <ol className="flex flex-wrap gap-1 text-[11px]">
        {steps.map((step, index) => {
          const done = completed > index;
          const current = completed === index;
          const revokeFailed = step.key === 'revoke' && failedRevoke;
          return (
            <li
              key={step.key}
              className={
                revokeFailed
                  ? 'rounded bg-destructive/10 px-2 py-1 text-destructive'
                  : done
                    ? 'rounded bg-emerald-500/10 px-2 py-1 text-emerald-700 dark:text-emerald-300'
                    : current
                      ? 'rounded bg-amber-500/10 px-2 py-1'
                      : 'rounded bg-muted px-2 py-1 text-muted-foreground'
              }
            >
              {index + 1}. {step.label}
              {done ? ' ✓' : revokeFailed ? ' 失败' : current ? ' …' : ''}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function trustWizardCompletedSteps(state: CertificateTrustState): number {
  switch (state) {
    case CertificateTrustState.Trusted:
      return 1;
    case CertificateTrustState.Verified:
      return 2;
    case CertificateTrustState.Revoked:
      return 3;
    case CertificateTrustState.CleanupFailed:
      return 2;
    default:
      return 0;
  }
}

function certTrustStateLabel(state: CertificateTrustState): string {
  switch (state) {
    case CertificateTrustState.Pending:
      return '待信任';
    case CertificateTrustState.Trusted:
      return '已信任新证书';
    case CertificateTrustState.Verified:
      return '已切换';
    case CertificateTrustState.Revoked:
      return '已撤销旧证书';
    case CertificateTrustState.CleanupFailed:
      return '撤销旧证书失败';
    default:
      return state;
  }
}
