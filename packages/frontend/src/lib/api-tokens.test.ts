import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error.js';
import {
  apiTokenCreateError,
  apiTokenDeleteError,
  sortApiTokens,
  validateApiTokenForm,
} from './api-tokens.js';

describe('validateApiTokenForm', () => {
  it('trims the name and keeps the password verbatim', () => {
    expect(validateApiTokenForm({ name: '  ci  ', currentPassword: ' pw ' }))
      .toEqual({ ok: true, body: { name: 'ci', currentPassword: ' pw ' } });
  });

  it('requires a name and the current password', () => {
    expect(validateApiTokenForm({ name: '   ', currentPassword: '' })).toEqual({
      ok: false,
      errors: { name: '请输入令牌名称', currentPassword: '请输入当前密码' },
    });
  });

  it('rejects names longer than the Backend accepts', () => {
    const result = validateApiTokenForm({ name: 'x'.repeat(129), currentPassword: 'pw' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors.name).toMatch(/128/);
  });
});

describe('apiTokenCreateError', () => {
  it('puts a wrong current password on the password field', () => {
    expect(apiTokenCreateError(new ApiError(403, 'CURRENT_PASSWORD_INCORRECT', 'Current password is incorrect')))
      .toEqual({ field: 'currentPassword', message: '当前密码不正确' });
  });

  it('does not blame the password when the browser session itself expired', () => {
    expect(apiTokenCreateError(new ApiError(401, 'UNAUTHORIZED', '会话已过期，请重新登录')))
      .toEqual({ message: '会话已过期，请重新登录' });
    expect(apiTokenCreateError(new ApiError(401, 'SESSION_CHANGED', '会话已切换')).field).toBeUndefined();
  });

  it('maps browser-session, rate-limit, capacity and validation failures to Chinese', () => {
    expect(apiTokenCreateError(new ApiError(403, 'API_TOKEN_REQUIRES_BROWSER_SESSION', 'x')).message)
      .toBe('只能在浏览器登录会话中创建 API 令牌');
    expect(apiTokenCreateError(new ApiError(429, 'AUTH_RATE_LIMITED', 'x')).message)
      .toBe('密码错误次数过多，请稍后再试');
    expect(apiTokenCreateError(new ApiError(409, 'API_TOKEN_CAPACITY_REACHED', 'x')).message)
      .toMatch(/上限/);
    expect(apiTokenCreateError(new ApiError(400, 'INVALID_INPUT', 'x')).message)
      .toBe('令牌名称或当前密码格式无效');
  });

  it('falls back to the error message', () => {
    expect(apiTokenCreateError(new ApiError(0, 'NETWORK_ERROR', '无法连接服务器')).message).toBe('无法连接服务器');
    expect(apiTokenCreateError('boom').message).toBe('创建失败，请稍后重试');
  });
});

describe('apiTokenDeleteError', () => {
  it('explains a token that is already gone', () => {
    expect(apiTokenDeleteError(new ApiError(404, 'UNKNOWN', 'Token not found'))).toBe('令牌不存在或已被删除');
    expect(apiTokenDeleteError(new ApiError(0, 'NETWORK_ERROR', '无法连接服务器'))).toBe('无法连接服务器');
  });
});

describe('sortApiTokens', () => {
  it('lists the newest token first without mutating the input', () => {
    const tokens = [
      { id: 'a', name: 'old', lastUsedAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'b', name: 'new', lastUsedAt: '2026-03-01T00:00:00.000Z', createdAt: '2026-02-01T00:00:00.000Z' },
    ];
    expect(sortApiTokens(tokens).map((token) => token.id)).toEqual(['b', 'a']);
    expect(tokens.map((token) => token.id)).toEqual(['a', 'b']);
  });
});
