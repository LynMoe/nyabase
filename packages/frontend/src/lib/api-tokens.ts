import { type CreateApiTokenRequest, zCreateApiTokenRequest } from '@nyabase/common';
import { ApiError, errorMessage } from './api-error.js';

/** Row of `GET /auth/tokens` (the Backend never returns the secret again). */
export interface ApiTokenDto {
  id: string;
  name: string;
  lastUsedAt: string | null;
  createdAt: string;
}

/** `POST /auth/tokens`: the plaintext `secret` is only in this response. */
export interface CreatedApiTokenResponse {
  token: ApiTokenDto;
  secret: string;
}

export const API_TOKEN_NAME_MAX = 128;

export type ApiTokenFormErrors = Partial<Record<'name' | 'currentPassword', string>>;

export type ApiTokenFormResult =
  | { ok: true; body: CreateApiTokenRequest }
  | { ok: false; errors: ApiTokenFormErrors };

export function validateApiTokenForm(form: { name: string; currentPassword: string }): ApiTokenFormResult {
  const errors: ApiTokenFormErrors = {};
  const name = form.name.trim();
  if (!name) errors.name = '请输入令牌名称';
  else if (name.length > API_TOKEN_NAME_MAX) errors.name = `名称最多 ${API_TOKEN_NAME_MAX} 个字符`;
  if (!form.currentPassword) errors.currentPassword = '请输入当前密码';
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const parsed = zCreateApiTokenRequest.safeParse({ name, currentPassword: form.currentPassword });
  if (parsed.success) return { ok: true, body: parsed.data };
  for (const issue of parsed.error.issues) {
    if (issue.path[0] === 'name' && !errors.name) errors.name = '名称格式无效';
    if (issue.path[0] === 'currentPassword' && !errors.currentPassword) errors.currentPassword = '密码格式无效';
  }
  return { ok: false, errors };
}

/**
 * Chinese copy for a failed token mint. A wrong current password comes back
 * on the password field; everything else is a form-level message.
 */
export function apiTokenCreateError(error: unknown): { field?: 'currentPassword'; message: string } {
  if (!(error instanceof ApiError)) return { message: errorMessage(error, '创建失败，请稍后重试') };
  if (error.status === 403 && error.code === 'CURRENT_PASSWORD_INCORRECT') {
    return { field: 'currentPassword', message: '当前密码不正确' };
  }
  if (error.status === 403 && error.code === 'API_TOKEN_REQUIRES_BROWSER_SESSION') {
    return { message: '只能在浏览器登录会话中创建 API 令牌' };
  }
  if (error.status === 429) return { message: '密码错误次数过多，请稍后再试' };
  if (error.status === 409 && error.code === 'API_TOKEN_CAPACITY_REACHED') {
    return { message: 'API 令牌数量已达上限，请先删除不再使用的令牌' };
  }
  if (error.status === 400) return { message: '令牌名称或当前密码格式无效' };
  return { message: error.message };
}

export function apiTokenDeleteError(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) return '令牌不存在或已被删除';
  return errorMessage(error, '删除失败，请稍后重试');
}

/** Newest first; the Backend's order is not part of the contract. */
export function sortApiTokens(tokens: readonly ApiTokenDto[]): ApiTokenDto[] {
  return [...tokens].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function formatTokenTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
