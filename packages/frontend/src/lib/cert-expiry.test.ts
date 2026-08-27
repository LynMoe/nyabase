import { describe, expect, it } from 'vitest';
import {
  CERT_WARNING_DAYS,
  certExpiryBannerText,
  certExpiryWarning,
  certRemainingDays,
  formatCertRemainingLabel,
} from './cert-expiry.js';

describe('cert expiry warning', () => {
  const now = Date.parse('2026-08-13T00:00:00.000Z');

  it('warns from 90 days before notAfter and when already expired', () => {
    expect(CERT_WARNING_DAYS).toBe(90);
    expect(certExpiryWarning(new Date(now + 90 * 86_400_000).toISOString(), now)).toBe('expiring');
    expect(certExpiryWarning(new Date(now + 91 * 86_400_000).toISOString(), now)).toBeNull();
    expect(certExpiryWarning(new Date(now - 86_400_000).toISOString(), now)).toBe('expired');
  });

  it('formats remaining days and banner copy in Chinese', () => {
    const notAfter = new Date(now + 12 * 86_400_000).toISOString();
    expect(certRemainingDays(notAfter, now)).toBe(12);
    expect(formatCertRemainingLabel(notAfter, now)).toMatch(/剩余 12 天/);
    expect(certExpiryBannerText(notAfter)).toMatch(/客户端证书将于 .* 过期，请轮换/);
    expect(certExpiryBannerText(new Date(now - 86_400_000).toISOString())).toMatch(/已于 .* 过期，请轮换/);
  });
});
