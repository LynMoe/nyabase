import { FailureCode } from '@nyabase/common';
import { describe, expect, it } from 'vitest';
import {
  CONSOLE_CLOSE_SESSION_REVOKED,
  CONSOLE_SESSION_REVOKED_MESSAGE,
  consoleCloseMessage,
  consoleErrorMessage,
} from './console-errors.js';

describe('console error copy', () => {
  it('shows a Chinese message for a revoked session instead of the Backend English', () => {
    expect(consoleErrorMessage('CONSOLE_SESSION_REVOKED', 'The session was revoked'))
      .toBe('会话已失效，请重新登录后再打开控制台');
  });

  it('maps the other bridge codes and reuses failure-code labels', () => {
    expect(consoleErrorMessage('CONSOLE_SESSION_INVALID', 'Console session is invalid')).toMatch(/重连/);
    expect(consoleErrorMessage('CONSOLE_BRIDGE_FAILED', 'Unauthorized')).toMatch(/重连/);
    expect(consoleErrorMessage(FailureCode.PermissionDenied, 'denied')).toBe('权限不足');
  });

  it('keeps the Backend message for unknown codes', () => {
    expect(consoleErrorMessage('SOMETHING_NEW', 'agent offline')).toBe('agent offline');
  });

  it('treats close code 4401 as a revoked session even without an error frame', () => {
    expect(CONSOLE_CLOSE_SESSION_REVOKED).toBe(4401);
    expect(consoleCloseMessage(4401)).toBe(CONSOLE_SESSION_REVOKED_MESSAGE);
    expect(consoleCloseMessage(1000)).toBeNull();
    expect(consoleCloseMessage(1011)).toBeNull();
  });
});
