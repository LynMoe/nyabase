import { RotateCw, ShieldCheck } from 'lucide-react';
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
import { Field } from '../layout/field.js';

export function CertificateCard({
  serverNames,
  canViewCertificate,
  canManageCertificates,
  certificateQuery,
  rotatePending,
  rotateOpen,
  onRotateOpenChange,
  onRotate,
}: {
  /** Display names for the trust rows; ids fall back to a resource ref. */
  serverNames?: ReadonlyMap<string, string>;
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
    <Card id="client-certificate" className="scroll-mt-6" data-testid="certificate-rotation">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />Incus 客户端证书</CardTitle>
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
                  serverNames={serverNames}
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
          description="会生成一张新的客户端证书，并逐台服务器完成「信任新证书 → 切换 → 撤销旧证书」。期间与 Incus 的连接可能短暂中断。"
          confirmLabel="确认轮换"
          pendingLabel="提交中..."
          pending={rotatePending}
          onConfirm={onRotate}
        />
      ) : null}
    </Card>
  );
}

/** An active certificate past notAfter is the thing to fix, so it must not read as healthy. */
function certificateStateLabel(state: string, notAfter: string): string {
  if (state === CertificateState.Active && certExpiryWarning(notAfter) === 'expired') return '使用中 · 已过期';
  switch (state) {
    case CertificateState.Staged: return '轮换中';
    case CertificateState.Active: return '使用中';
    case CertificateState.Retired: return '已停用';
    case CertificateState.Failed: return '失败';
    default: return state;
  }
}

function certificateStateVariant(state: string, notAfter: string): 'success' | 'secondary' | 'destructive' | 'warning' {
  if (state === CertificateState.Active) {
    const expiry = certExpiryWarning(notAfter);
    return expiry === 'expired' ? 'destructive' : expiry === 'expiring' ? 'warning' : 'success';
  }
  if (state === CertificateState.Failed) return 'destructive';
  if (state === CertificateState.Staged) return 'warning';
  return 'secondary';
}

function CertificateDetails({
  serverNames,
  certificate,
  showIntentFailures,
}: {
  serverNames?: ReadonlyMap<string, string>;
  certificate: IncusClientCertificateDto;
  showIntentFailures: boolean;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="代次" value={String(certificate.generation)} />
        <Field label="指纹" value={<TechnicalId label="指纹" value={certificate.fingerprint} kind="fingerprint" />} />
        <Field
          label="状态"
          value={(
            <StatusBadge
              label={certificateStateLabel(certificate.state, certificate.notAfter)}
              raw={certificate.state}
              pending={certificateStatePending(certificate.state)}
              variant={certificateStateVariant(certificate.state, certificate.notAfter)}
            />
          )}
        />
        <Field label="生效时间" value={new Date(certificate.notBefore).toLocaleString()} />
        <Field label="过期时间" value={new Date(certificate.notAfter).toLocaleString()} />
        <Field
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
            serverName={serverNames?.get(trust.serverId)}
            trust={trust}
          />
        ))}
      </div>
    </div>
  );
}

function CertificateTrustWizard({
  serverName,
  trust,
}: {
  serverName?: string;
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
              name={serverName}
            />
          </p>
          <p className="text-xs text-muted-foreground">{trust.lastError ?? relativeTime(trust.observedAt)}</p>
        </div>
        <StatusBadge
          label={certTrustStateLabel(trust.trustState)}
          pending={certificateTrustPending(trust.trustState)}
          variant={
            trust.trustState === CertificateTrustState.Verified
              || trust.trustState === CertificateTrustState.Revoked
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
                    ? 'rounded bg-success/10 px-2 py-1 text-success'
                    : current
                      ? 'rounded bg-warning/10 px-2 py-1 text-warning'
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
