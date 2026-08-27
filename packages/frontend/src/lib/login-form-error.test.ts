import { describe, expect, it } from 'vitest';
import { ApiError } from './api-error.js';
import { loginFailureMessage } from './login-form-error.js';

describe('loginFailureMessage', () => {
  it('keeps 401 as a credential error', () => {
    expect(loginFailureMessage(new ApiError(401, 'UNAUTHORIZED', 'Invalid credentials')))
      .toBe('用户名或密码错误');
  });

  it('maps a disabled-account code on 403', () => {
    expect(loginFailureMessage(new ApiError(403, 'USER_DISABLED', 'User is disabled')))
      .toBe('账号已停用');
  });

  it('maps other 403 responses to an unavailable account', () => {
    expect(loginFailureMessage(new ApiError(403, 'FORBIDDEN', 'Forbidden')))
      .toBe('账号不可用');
  });

  it('keeps network failures distinct from credential errors', () => {
    expect(loginFailureMessage(new ApiError(0, 'NETWORK_ERROR', 'offline')))
      .toBe('无法连接服务器，请检查网络后重试。');
  });
});
