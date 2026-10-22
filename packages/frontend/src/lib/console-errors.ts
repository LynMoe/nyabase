import { failureCodeLabel } from './status-labels.js';

/** Close code the Backend console bridge uses when the signed-in session was revoked. */
export const CONSOLE_CLOSE_SESSION_REVOKED = 4401;

export const CONSOLE_SESSION_REVOKED_MESSAGE = '会话已失效，请重新登录后再打开控制台';

/** `{ type: 'error', code }` frames from `/ws/console`; the Backend's `message` is English. */
const CONSOLE_ERROR_ZH: Partial<Record<string, string>> = {
  CONSOLE_SESSION_REVOKED: CONSOLE_SESSION_REVOKED_MESSAGE,
  CONSOLE_SESSION_INVALID: '控制台会话无效或已过期，请点击重连',
  CONSOLE_BRIDGE_FAILED: '控制台连接失败，请点击重连',
  CONSOLE_FRAME_INVALID: '控制台消息格式无效，请点击重连',
};

/** Chinese copy for a console error frame; unknown codes keep the Backend's message. */
export function consoleErrorMessage(code: string, message: string): string {
  const known = CONSOLE_ERROR_ZH[code];
  if (known) return known;
  const failure = failureCodeLabel(code);
  if (failure && failure !== code) return failure;
  return message || '控制台错误。';
}

/** A close code that carries its own meaning even if the error frame was lost. */
export function consoleCloseMessage(closeCode: number): string | null {
  return closeCode === CONSOLE_CLOSE_SESSION_REVOKED ? CONSOLE_SESSION_REVOKED_MESSAGE : null;
}
