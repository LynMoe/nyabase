import type { Page } from '@playwright/test';

interface ConsoleResult {
  output: string;
  exitCode: number;
}

export async function executeThroughConsole(
  page: Page,
  baseUrl: string,
  sessionId: string,
  accessToken: string,
  input: string,
  timeoutMs = 20_000,
): Promise<ConsoleResult> {
  return page.evaluate(
    ({ httpBase, id, token, stdin, timeout }) => new Promise<ConsoleResult>((resolve, reject) => {
      const url = new URL('/ws/console', httpBase);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('sessionId', id);
      const socket = new WebSocket(url);
      const decoder = new TextDecoder();
      let output = '';
      let terminal = false;
      const timer = window.setTimeout(() => {
        socket.close();
        reject(new Error(`Console ${id} timed out after ${timeout}ms; output=${output}`));
      }, timeout);

      const finish = (result: ConsoleResult) => {
        if (terminal) return;
        terminal = true;
        window.clearTimeout(timer);
        resolve(result);
      };
      const fail = (error: Error) => {
        if (terminal) return;
        terminal = true;
        window.clearTimeout(timer);
        reject(error);
      };

      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token }));
        socket.send(JSON.stringify({ type: 'input', data: stdin }));
      };
      socket.onmessage = (event) => {
        let message: { type?: string; data?: string; exitCode?: number };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch (error) {
          fail(new Error(`Console ${id} returned invalid JSON: ${String(error)}`));
          return;
        }
        if (message.type === 'data' && typeof message.data === 'string') {
          const binary = atob(message.data);
          const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
          output += decoder.decode(bytes, { stream: true });
        }
        if (message.type === 'eof') {
          output += decoder.decode();
          finish({ output, exitCode: message.exitCode ?? -1 });
        }
      };
      socket.onerror = () => fail(new Error(`Console ${id} WebSocket transport failed`));
      socket.onclose = (event) => {
        if (!terminal) fail(new Error(`Console ${id} closed before EOF: ${event.code} ${event.reason}`));
      };
    }),
    { httpBase: baseUrl, id: sessionId, token: accessToken, stdin: input, timeout: timeoutMs },
  );
}
