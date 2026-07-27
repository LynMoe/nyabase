import type { Page } from '@playwright/test';

export interface ConsoleSession {
  sessionId: string;
  consoleUrl: string;
}

export interface ConsoleResult {
  output: string;
  exitCode: number;
  websocketUrl: string;
  closeCode: number;
  closeReason: string;
  closeWasClean: boolean;
}

export interface ConsoleCloseResult {
  output: string;
  websocketUrl: string;
  closeCode: number;
  closeReason: string;
  closeWasClean: boolean;
}

export interface PersistentConsoleOpenResult {
  websocketUrl: string;
  output: string;
}

export interface PersistentConsoleClosedResult {
  websocketUrl: string;
  output: string;
  openedAt: number;
  closedAt: number;
  closeCode: number;
  closeReason: string;
  closeWasClean: boolean;
  followupAccepted: false;
}

export async function executeThroughConsole(
  page: Page,
  baseUrl: string,
  session: ConsoleSession,
  accessToken: string,
  input: string,
  timeoutMs = 20_000,
): Promise<ConsoleResult> {
  return page.evaluate(
    ({ httpBase, consoleSession, token, stdin, timeout }) =>
      new Promise<ConsoleResult>((resolve, reject) => {
        const { sessionId: id, consoleUrl } = consoleSession;
        const url = new URL(consoleUrl, httpBase);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        if (
          (url.protocol !== 'ws:' && url.protocol !== 'wss:')
          || url.pathname !== '/ws/console'
          || url.hash !== ''
          || [...url.searchParams].length !== 1
          || url.searchParams.get('sessionId') !== id
        ) {
          reject(new Error(`Console ${id} returned an invalid owner URL`));
          return;
        }
        const socket = new WebSocket(url);
        const decoder = new TextDecoder();
        let output = '';
        let terminal = false;
        let eofExitCode: number | null = null;
        const timer = window.setTimeout(() => {
          socket.close();
          fail(new Error(`Console ${id} timed out after ${timeout}ms; output=${output}`));
        }, timeout);

        const finish = (result: ConsoleResult) => {
          if (terminal) return;
          terminal = true;
          window.clearTimeout(timer);
          resolve(result);
        };
        function fail(error: Error) {
          if (terminal) return;
          terminal = true;
          window.clearTimeout(timer);
          reject(error);
        }

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
            eofExitCode = message.exitCode ?? -1;
          }
        };
        socket.onerror = () => fail(new Error(`Console ${id} WebSocket transport failed`));
        socket.onclose = (event) => {
          if (eofExitCode === null) {
            fail(new Error(`Console ${id} closed before EOF: ${event.code} ${event.reason}`));
            return;
          }
          finish({
            output,
            exitCode: eofExitCode,
            websocketUrl: socket.url,
            closeCode: event.code,
            closeReason: event.reason,
            closeWasClean: event.wasClean,
          });
        };
      }),
    {
      httpBase: baseUrl,
      consoleSession: session,
      token: accessToken,
      stdin: input,
      timeout: timeoutMs,
    },
  );
}

export async function closeConsoleAfterOutput(
  page: Page,
  baseUrl: string,
  session: ConsoleSession,
  accessToken: string,
  input: string,
  outputMarker: string,
  timeoutMs = 20_000,
): Promise<ConsoleCloseResult> {
  return page.evaluate(
    ({ httpBase, consoleSession, token, stdin, marker, timeout }) =>
      new Promise<ConsoleCloseResult>((resolve, reject) => {
        const { sessionId: id, consoleUrl } = consoleSession;
        const url = new URL(consoleUrl, httpBase);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        if (
          (url.protocol !== 'ws:' && url.protocol !== 'wss:')
          || url.pathname !== '/ws/console'
          || url.hash !== ''
          || [...url.searchParams].length !== 1
          || url.searchParams.get('sessionId') !== id
        ) {
          reject(new Error(`Console ${id} returned an invalid owner URL`));
          return;
        }
        const socket = new WebSocket(url);
        const decoder = new TextDecoder();
        let output = '';
        let terminal = false;
        let requestedClose = false;
        const timer = window.setTimeout(() => {
          socket.close();
          fail(new Error(`Console ${id} close probe timed out; output=${output}`));
        }, timeout);

        const finish = (result: ConsoleCloseResult) => {
          if (terminal) return;
          terminal = true;
          window.clearTimeout(timer);
          resolve(result);
        };
        function fail(error: Error) {
          if (terminal) return;
          terminal = true;
          window.clearTimeout(timer);
          reject(error);
        }

        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'auth', token }));
          socket.send(JSON.stringify({ type: 'input', data: stdin }));
        };
        socket.onmessage = (event) => {
          let message: { type?: string; data?: string };
          try {
            message = JSON.parse(String(event.data)) as typeof message;
          } catch (error) {
            fail(new Error(`Console ${id} returned invalid JSON: ${String(error)}`));
            return;
          }
          if (message.type === 'eof') {
            fail(new Error(`Console ${id} exited before browser close`));
            return;
          }
          if (message.type === 'data' && typeof message.data === 'string') {
            const binary = atob(message.data);
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            output += decoder.decode(bytes, { stream: true });
            if (!requestedClose && output.includes(marker)) {
              requestedClose = true;
              socket.close(1000, 'E2E browser close');
            }
          }
        };
        socket.onerror = () => fail(new Error(`Console ${id} WebSocket transport failed`));
        socket.onclose = (event) => {
          if (!requestedClose || !output.includes(marker)) {
            fail(new Error(`Console ${id} closed before the output marker`));
            return;
          }
          finish({
            output,
            websocketUrl: socket.url,
            closeCode: event.code,
            closeReason: event.reason,
            closeWasClean: event.wasClean,
          });
        };
      }),
    {
      httpBase: baseUrl,
      consoleSession: session,
      token: accessToken,
      stdin: input,
      marker: outputMarker,
      timeout: timeoutMs,
    },
  );
}

export async function openPersistentConsoleUntilOutput(
  page: Page,
  baseUrl: string,
  session: ConsoleSession,
  accessToken: string,
  input: string,
  outputMarker: string,
  timeoutMs = 20_000,
): Promise<PersistentConsoleOpenResult> {
  return page.evaluate(
    ({ httpBase, consoleSession, token, stdin, marker, timeout }) =>
      new Promise<PersistentConsoleOpenResult>((resolve, reject) => {
        const { sessionId: id, consoleUrl } = consoleSession;
        const url = new URL(consoleUrl, httpBase);
        if (url.protocol === 'http:') url.protocol = 'ws:';
        if (url.protocol === 'https:') url.protocol = 'wss:';
        if (
          (url.protocol !== 'ws:' && url.protocol !== 'wss:')
          || url.pathname !== '/ws/console'
          || url.hash !== ''
          || [...url.searchParams].length !== 1
          || url.searchParams.get('sessionId') !== id
        ) {
          reject(new Error(`Console ${id} returned an invalid owner URL`));
          return;
        }
        const socket = new WebSocket(url);
        const decoder = new TextDecoder();
        const record = {
          socket,
          output: '',
          openedAt: 0,
          closedAt: 0,
          closeCode: 0,
          closeReason: '',
          closeWasClean: false,
        };
        const records = window as typeof window & {
          __nyabasePersistentConsoles?: Record<string, typeof record>;
        };
        records.__nyabasePersistentConsoles ??= {};
        records.__nyabasePersistentConsoles[id] = record;
        let settled = false;
        const timer = window.setTimeout(() => {
          socket.close();
          if (!settled) reject(new Error(`Console ${id} open probe timed out`));
        }, timeout);
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          reject(error);
        };

        socket.onopen = () => {
          record.openedAt = Date.now();
          socket.send(JSON.stringify({ type: 'auth', token }));
          socket.send(JSON.stringify({ type: 'input', data: stdin }));
        };
        socket.onmessage = (event) => {
          let message: { type?: string; data?: string };
          try {
            message = JSON.parse(String(event.data)) as typeof message;
          } catch (error) {
            fail(new Error(`Console ${id} returned invalid JSON: ${String(error)}`));
            return;
          }
          if (message.type === 'eof') {
            fail(new Error(`Console ${id} exited before takeover`));
            return;
          }
          if (message.type === 'data' && typeof message.data === 'string') {
            const binary = atob(message.data);
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            record.output += decoder.decode(bytes, { stream: true });
            if (!settled && record.output.includes(marker)) {
              settled = true;
              window.clearTimeout(timer);
              resolve({ websocketUrl: socket.url, output: record.output });
            }
          }
        };
        socket.onerror = () => fail(new Error(`Console ${id} WebSocket transport failed`));
        socket.onclose = (event) => {
          record.closedAt = Date.now();
          record.closeCode = event.code;
          record.closeReason = event.reason;
          record.closeWasClean = event.wasClean;
          if (!settled) fail(new Error(`Console ${id} closed before takeover marker`));
        };
      }),
    {
      httpBase: baseUrl,
      consoleSession: session,
      token: accessToken,
      stdin: input,
      marker: outputMarker,
      timeout: timeoutMs,
    },
  );
}

export async function requirePersistentConsoleClosed(
  page: Page,
  sessionId: string,
  forbiddenInput: string,
  forbiddenOutputMarker: string,
  timeoutMs = 5_000,
): Promise<PersistentConsoleClosedResult> {
  return page.evaluate(
    async ({ id, forbiddenStdin, forbiddenMarker, timeout }) => {
      type RecordValue = {
        socket: WebSocket;
        output: string;
        openedAt: number;
        closedAt: number;
        closeCode: number;
        closeReason: string;
        closeWasClean: boolean;
      };
      const records = window as typeof window & {
        __nyabasePersistentConsoles?: Record<string, RecordValue>;
      };
      const record = records.__nyabasePersistentConsoles?.[id];
      if (!record) throw new Error(`Console ${id} persistent record is absent`);
      const deadline = Date.now() + timeout;
      while (record.socket.readyState !== WebSocket.CLOSED && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 25));
      }
      if (record.socket.readyState !== WebSocket.CLOSED || record.closedAt === 0) {
        throw new Error(`Console ${id} remained open after takeover`);
      }
      // Browsers silently discard send() while CLOSING or CLOSED, and some
      // still increase bufferedAmount for that discarded frame. The durable
      // CLOSED state plus absence of forbidden Agent output is the delivery
      // fence; bufferedAmount is not delivery evidence.
      try {
        record.socket.send(JSON.stringify({ type: 'input', data: forbiddenStdin }));
      } catch {
        // Throwing is also valid proof that the closed transport rejected the frame.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      if (record.socket.readyState !== WebSocket.CLOSED) {
        throw new Error(`Console ${id} left the closed state after takeover`);
      }
      if (record.output.includes(forbiddenMarker)) {
        throw new Error(`Console ${id} accepted output after takeover`);
      }
      delete records.__nyabasePersistentConsoles?.[id];
      return {
        websocketUrl: record.socket.url,
        output: record.output,
        openedAt: record.openedAt,
        closedAt: record.closedAt,
        closeCode: record.closeCode,
        closeReason: record.closeReason,
        closeWasClean: record.closeWasClean,
        followupAccepted: false,
      };
    },
    {
      id: sessionId,
      forbiddenStdin: forbiddenInput,
      forbiddenMarker: forbiddenOutputMarker,
      timeout: timeoutMs,
    },
  );
}

export async function closePersistentConsoleForCleanup(
  page: Page,
  sessionId: string,
): Promise<void> {
  await page.evaluate((id) => {
    type RecordValue = { socket: WebSocket };
    const records = window as typeof window & {
      __nyabasePersistentConsoles?: Record<string, RecordValue>;
    };
    const record = records.__nyabasePersistentConsoles?.[id];
    if (record?.socket.readyState === WebSocket.OPEN) {
      record.socket.close(1000, 'E2E cleanup');
    } else if (record?.socket.readyState === WebSocket.CONNECTING) {
      record.socket.close();
    }
    delete records.__nyabasePersistentConsoles?.[id];
  }, sessionId);
}
