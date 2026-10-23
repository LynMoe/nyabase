import { failureCodeLabel } from './status-labels.js';

/**
 * Close code the Backend console bridge uses when the browser session that
 * opened the console ended (logout here or in another tab, revocation).
 */
export const CONSOLE_CLOSE_SESSION_REVOKED = 4401;

export const CONSOLE_SESSION_REVOKED_MESSAGE = '会话已失效，请重新登录后再打开控制台';

/** Close code used when the console was not re-authenticated before its access token expired. */
export const CONSOLE_CLOSE_AUTH_EXPIRED = 4408;

export const CONSOLE_AUTH_EXPIRED_MESSAGE = '登录凭据已过期，控制台已断开，请点击重连';

/** Close code used when the browser stopped reading and console output piled up. */
export const CONSOLE_CLOSE_OUTPUT_OVERFLOW = 4413;

export const CONSOLE_OUTPUT_OVERFLOW_MESSAGE = '控制台输出过快，浏览器来不及接收，连接已断开，请点击重连';

/**
 * Close code used when more input arrived than the console holds: typed or
 * pasted before the shell opened, or one frame over the bridge's size limit
 * (the WebSocket standard "message too big").
 */
export const CONSOLE_CLOSE_INPUT_OVERFLOW = 1009;

export const CONSOLE_INPUT_OVERFLOW_MESSAGE = '控制台输入过多，连接已断开，请点击重连';

/** `{ type: 'error', code }` frames from `/ws/console`; the Backend's `message` is English. */
const CONSOLE_ERROR_ZH: Partial<Record<string, string>> = {
  CONSOLE_SESSION_REVOKED: CONSOLE_SESSION_REVOKED_MESSAGE,
  CONSOLE_AUTH_EXPIRED: CONSOLE_AUTH_EXPIRED_MESSAGE,
  CONSOLE_SESSION_INVALID: '控制台会话无效或已过期，请点击重连',
  CONSOLE_BRIDGE_FAILED: '控制台连接失败，请点击重连',
  CONSOLE_FRAME_INVALID: '控制台消息格式无效，请点击重连',
  CONSOLE_OUTPUT_OVERFLOW: CONSOLE_OUTPUT_OVERFLOW_MESSAGE,
  CONSOLE_INPUT_OVERFLOW: CONSOLE_INPUT_OVERFLOW_MESSAGE,
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
  if (closeCode === CONSOLE_CLOSE_SESSION_REVOKED) return CONSOLE_SESSION_REVOKED_MESSAGE;
  if (closeCode === CONSOLE_CLOSE_AUTH_EXPIRED) return CONSOLE_AUTH_EXPIRED_MESSAGE;
  if (closeCode === CONSOLE_CLOSE_OUTPUT_OVERFLOW) return CONSOLE_OUTPUT_OVERFLOW_MESSAGE;
  if (closeCode === CONSOLE_CLOSE_INPUT_OVERFLOW) return CONSOLE_INPUT_OVERFLOW_MESSAGE;
  return null;
}
