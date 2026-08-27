export const CERT_WARNING_DAYS = 90;
const MS_PER_DAY = 86_400_000;

export function certRemainingDays(notAfter: string, now = Date.now()): number {
  return Math.ceil((new Date(notAfter).getTime() - now) / MS_PER_DAY);
}

export function certExpiryWarning(
  notAfter: string,
  now = Date.now(),
): 'expired' | 'expiring' | null {
  const days = certRemainingDays(notAfter, now);
  if (!Number.isFinite(days)) return null;
  if (days <= 0) return 'expired';
  if (days <= CERT_WARNING_DAYS) return 'expiring';
  return null;
}

export function formatCertRemainingLabel(notAfter: string, now = Date.now()): string {
  const days = certRemainingDays(notAfter, now);
  if (!Number.isFinite(days)) return '有效期未知';
  if (days > 0) return `剩余 ${days} 天`;
  if (days === 0) return '今天过期';
  return `已过期 ${Math.abs(days)} 天`;
}

export function certExpiryBannerText(notAfter: string): string {
  const when = new Date(notAfter);
  const dateLabel = Number.isNaN(when.getTime()) ? '未知时间' : when.toLocaleDateString();
  if (certExpiryWarning(notAfter) === 'expired') {
    return `客户端证书已于 ${dateLabel} 过期，请轮换`;
  }
  return `客户端证书将于 ${dateLabel} 过期，请轮换`;
}
