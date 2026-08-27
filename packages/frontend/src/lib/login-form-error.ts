import { ApiError } from './api-error.js';

const DISABLED_ACCOUNT_RE = /disabled|user_disabled|account_disabled|停用/i;

export function loginFailureMessage(error: unknown): string {
  if (error instanceof ApiError && (error.code === 'NETWORK_ERROR' || error.status === 0)) {
    return '无法连接服务器，请检查网络后重试。';
  }
  if (error instanceof ApiError && error.status === 401) {
    return '用户名或密码错误';
  }
  if (error instanceof ApiError && error.status === 403) {
    return isDisabledAccountError(error) ? '账号已停用' : '账号不可用';
  }
  return error instanceof Error ? error.message : '登录失败，请稍后重试。';
}

function isDisabledAccountError(error: ApiError): boolean {
  return DISABLED_ACCOUNT_RE.test(`${error.code} ${error.message}`);
}
