import {
  HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS,
  PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS,
  normalizeHttpProxyHostname,
  normalizeHttpProxyWildcardDomain,
} from '@nyabase/common';

export interface ContainerOption {
  id: string;
  name: string;
}

export const emptyBindingForm = {
  hostname: '',
  containerId: '',
  targetPort: '80',
};

export const emptyPoolForm = {
  wildcardDomain: '',
  enabled: true,
  httpsEnabled: false,
  certificatePem: '',
  privateKeyPem: '',
};

export type BindingField = keyof typeof emptyBindingForm;
export type BindingFormErrors = Partial<Record<BindingField, string>>;
export type PoolField = keyof Pick<
  typeof emptyPoolForm,
  'wildcardDomain' | 'certificatePem' | 'privateKeyPem'
>;
export type PoolFormErrors = Partial<Record<PoolField, string>>;

export interface SaveBindingPayload {
  hostname: string;
  containerId: string;
  targetPort: number;
}

export interface SavePoolPayload {
  wildcardDomain: string;
  enabled: boolean;
  httpsEnabled: boolean;
  certificatePem?: string | null;
  privateKeyPem?: string | null;
}

export interface RetainedCertificateContext {
  fingerprint: string;
  wildcardDomain: string;
  notAfter: string | null;
}

export interface PoolValidationContext {
  isEditing: boolean;
  existingCertificate: RetainedCertificateContext | null;
  /** Test seam; production uses the same wall clock as the backend check. */
  nowMs?: number;
}

export function validateBindingForm(
  form: typeof emptyBindingForm,
  containers: ContainerOption[] | null,
): { errors: BindingFormErrors; payload: SaveBindingPayload | null } {
  const errors: BindingFormErrors = {};
  const rawHostname = form.hostname.trim();
  let hostname = '';
  if (!rawHostname) {
    errors.hostname = '请输入域名';
  } else {
    try {
      hostname = normalizeHttpProxyHostname(rawHostname);
    } catch {
      errors.hostname = '请输入有效域名，如 app.apps.example.com';
    }
    if (hostname && (hostname.startsWith('*.') || hostname.includes('*'))) {
      errors.hostname = '绑定域名不能使用通配符';
    } else if (hostname && !isValidHostname(hostname)) {
      errors.hostname = '请输入有效域名，如 app.apps.example.com';
    }
  }

  if (!form.containerId) {
    errors.containerId = '请选择目标容器';
  } else if (containers === null) {
    errors.containerId = '容器目录尚未加载，请重试';
  } else if (!containers.some((container) => container.id === form.containerId)) {
    errors.containerId = '请选择有效容器';
  }

  const targetPort = Number(form.targetPort);
  if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    errors.targetPort = '端口必须是 1 到 65535 之间的整数';
  }

  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return {
    errors,
    payload: { hostname, containerId: form.containerId, targetPort },
  };
}

export function validatePoolForm(
  form: typeof emptyPoolForm,
  context: PoolValidationContext,
): { errors: PoolFormErrors; payload: SavePoolPayload | null } {
  const { isEditing, existingCertificate } = context;
  const errors: PoolFormErrors = {};
  const rawWildcardDomain = form.wildcardDomain.trim();
  let wildcardDomain = '';
  if (!rawWildcardDomain) {
    errors.wildcardDomain = '请输入通配根域';
  } else {
    try {
      wildcardDomain = normalizeHttpProxyWildcardDomain(rawWildcardDomain);
    } catch {
      errors.wildcardDomain = '请输入有效通配域名，如 *.apps.example.com';
    }
    if (wildcardDomain && !isValidWildcardDomain(wildcardDomain)) {
      errors.wildcardDomain = '请输入有效通配域名，如 *.apps.example.com';
    }
  }

  const certificatePem = form.certificatePem.trim();
  const privateKeyPem = form.privateKeyPem.trim();
  const retainedCertificateSafe = Boolean(existingCertificate
    && existingCertificate.fingerprint
    && sameWildcard(existingCertificate.wildcardDomain, wildcardDomain)
    && safeCertificateLease(existingCertificate.notAfter, context.nowMs ?? Date.now()));
  if ((certificatePem && !privateKeyPem) || (!certificatePem && privateKeyPem)) {
    const message = '证书 PEM 与私钥 PEM 必须成对填写';
    errors.certificatePem = message;
    errors.privateKeyPem = message;
  }
  if (form.httpsEnabled && !certificatePem && !privateKeyPem && !retainedCertificateSafe) {
    const message = '启用 HTTPS 必须提供有效的证书 PEM 与私钥 PEM';
    errors.certificatePem = message;
    errors.privateKeyPem = message;
  }

  if (Object.keys(errors).length > 0) return { errors, payload: null };

  const payload: SavePoolPayload = {
    wildcardDomain,
    enabled: form.enabled,
    httpsEnabled: form.httpsEnabled,
  };
  if (!isEditing || certificatePem || privateKeyPem) {
    payload.certificatePem = certificatePem || null;
    payload.privateKeyPem = privateKeyPem || null;
  } else if (existingCertificate && !retainedCertificateSafe) {
    // A changed wildcard or unsafe remaining lease cannot retain the old pair.
    // HTTP-only edits clear it explicitly so the backend will not revalidate it
    // against a domain it no longer covers.
    payload.certificatePem = null;
    payload.privateKeyPem = null;
  }
  return { errors, payload };
}

function sameWildcard(left: string, right: string): boolean {
  try {
    return normalizeHttpProxyWildcardDomain(left) === normalizeHttpProxyWildcardDomain(right);
  } catch {
    return false;
  }
}

function safeCertificateLease(notAfter: string | null, nowMs: number): boolean {
  if (!notAfter || !Number.isFinite(nowMs)) return false;
  const expiry = Date.parse(notAfter);
  return Number.isFinite(expiry)
    && expiry > nowMs + HTTP_PROXY_SNAPSHOT_STALE_AFTER_MS + PROXY_SNAPSHOT_MAX_CLOCK_SKEW_MS;
}

function isValidWildcardDomain(wildcardDomain: string): boolean {
  if (!wildcardDomain.startsWith('*.')) return false;
  return isValidHostname(wildcardDomain.slice(2));
}

function isValidHostname(hostname: string): boolean {
  if (hostname.length > 253) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}
