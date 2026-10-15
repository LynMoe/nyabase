import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, X } from 'lucide-react';
import type { IncusClientCertificateDto } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { queryKeys } from '../../lib/query-keys.js';
import { certExpiryBannerText, certExpiryWarning } from '../../lib/cert-expiry.js';
import { cn } from '../../lib/utils.js';

const DISMISS_KEY = 'nyabase.certBanner.dismissed';

function readDismissed(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

function writeDismissed(value: string): void {
  try {
    window.sessionStorage.setItem(DISMISS_KEY, value);
  } catch {
    // Storage blocked: the banner just comes back on the next render.
  }
}

/**
 * Client-certificate expiry notice for whoever can rotate it. "Expiring" is a
 * warning and "expired" is destructive; either can be dismissed for this
 * browser session, and a new level (or a rotated certificate) shows again.
 */
export function CertExpiryBanner({ enabled }: { enabled: boolean }) {
  const certificateQuery = useQuery({
    queryKey: queryKeys.certificate,
    queryFn: () => api.get<IncusClientCertificateDto>('/admin/incus-client-certificate'),
    enabled,
    staleTime: 60_000,
  });
  const [dismissed, setDismissed] = useState(readDismissed);
  const certificate = certificateQuery.data;
  const level = certificate ? certExpiryWarning(certificate.notAfter) : null;
  if (!enabled || !certificate || !level) return null;

  const key = `${certificate.fingerprint}:${level}`;
  if (dismissed === key) return null;
  const expired = level === 'expired';

  return (
    <div
      role="status"
      data-testid="cert-expiry-banner"
      className={cn(
        'flex items-center gap-3 border-b px-4 py-2 text-sm md:px-6',
        expired ? 'border-destructive/30 bg-destructive/10' : 'border-warning/30 bg-warning/10',
      )}
    >
      <TriangleAlert className={cn('h-4 w-4 shrink-0', expired ? 'text-destructive' : 'text-warning')} />
      <p className="min-w-0 flex-1">
        {certExpiryBannerText(certificate.notAfter)}
        <Link to="/servers" hash="client-certificate" className="ml-2 font-medium underline underline-offset-4">
          去轮换
        </Link>
      </p>
      <button
        type="button"
        className="rounded p-1 text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        aria-label="本次会话不再提示"
        onClick={() => {
          writeDismissed(key);
          setDismissed(key);
        }}
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
