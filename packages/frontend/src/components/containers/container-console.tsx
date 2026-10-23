import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw, Terminal as TerminalIcon } from 'lucide-react';
import type { IDisposable } from '@xterm/xterm';
import { zConsoleToBrowser, type ContainerDto, type ExecSessionResponse, type ListScope } from '@nyabase/common';
import { api, freshAccessTokenWithRetry } from '../../lib/api.js';
import { consoleCloseMessage, consoleErrorMessage } from '../../lib/console-errors.js';
import { scopedPath } from '../../lib/scoped-paths.js';
import { useAuthStore } from '../../store/auth.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';

type ConsoleStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

/** xterm is loaded on demand; `open` mounts a fitted terminal. */
async function loadTerminal() {
  const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
    import('@xterm/addon-web-links'),
    import('@xterm/xterm/css/xterm.css'),
  ]);
  return {
    open(mount: HTMLElement) {
      const terminal = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13,
        theme: { background: '#09090b', foreground: '#f4f4f5', cursor: '#f4f4f5' },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.loadAddon(new WebLinksAddon());
      terminal.open(mount);
      fit.fit();
      return { terminal, fit };
    },
  };
}

/**
 * The answer to the bridge's `reauthenticate` prompts: a fresh access token of
 * the same browser session (`auth.sentToken` is the last one sent), one prompt
 * at a time, retried until it is sent, the socket closes or the console is
 * torn down.
 */
function consoleReauthenticator(
  socket: WebSocket,
  auth: { sentToken: string | null },
  cancelled: () => boolean,
): () => Promise<void> {
  let answering = false;
  const open = () => !cancelled() && socket.readyState === WebSocket.OPEN;
  return async () => {
    if (answering) return;
    answering = true;
    try {
      const token = await freshAccessTokenWithRetry(auth.sentToken, open);
      if (!token || !open()) return;
      auth.sentToken = token;
      socket.send(JSON.stringify({ type: 'auth', token }));
    } finally {
      answering = false;
    }
  };
}

export function ContainerConsole({ container, scope }: { container: ContainerDto; scope: ListScope }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const [status, setStatus] = useState<ConsoleStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  // Subscribe only to signed-in-ness: a token refresh must not tear down a live shell.
  const signedIn = useAuthStore((state) => state.accessToken !== null);
  const consoleEnabled = container.actions.console.enabled;
  const consoleMessage = container.actions.console.message;

  const cleanup = useCallback(() => {
    disposablesRef.current.forEach((disposable) => disposable.dispose());
    disposablesRef.current = [];
    socketRef.current?.close(1000, 'component cleanup');
    socketRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const connect = async () => {
      cleanup();
      setStatus('connecting');
      setError(null);
      if (!signedIn || !consoleEnabled || !mountRef.current) {
        setStatus('error');
        setError(!signedIn ? '登录已失效，请重新登录。' : consoleMessage ?? '当前容器不能打开控制台。');
        return;
      }
      try {
        const loaded = await loadTerminal();
        if (cancelled || !mountRef.current) return;
        const { terminal, fit } = loaded.open(mountRef.current);
        terminalRef.current = terminal;
        fitRef.current = fit;
        terminal.writeln('\x1b[90m正在连接控制台...\x1b[0m');
        const session = await api.post<ExecSessionResponse>(scopedPath(`/containers/${container.id}/exec-sessions`, scope), { tty: true, cols: terminal.cols || 100, rows: terminal.rows || 30 });
        if (cancelled) return;
        const resolved = new URL(session.consoleUrl, window.location.href);
        if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
        if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
        if (resolved.protocol !== 'ws:' && resolved.protocol !== 'wss:') throw new Error('控制台地址无效。');
        const socket = new WebSocket(resolved.toString());
        socketRef.current = socket;
        // The console is bound to this browser session and must be re-authenticated
        // with a fresh access token before the last one expires.
        const auth = { sentToken: null as string | null };
        const reauthenticate = consoleReauthenticator(socket, auth, () => cancelled);
        socket.addEventListener('open', () => {
          auth.sentToken = useAuthStore.getState().accessToken;
          socket.send(JSON.stringify({ type: 'auth', token: auth.sentToken }));
        });
        socket.addEventListener('message', (event) => {
          try {
            const parsed = zConsoleToBrowser.safeParse(JSON.parse(String(event.data)));
            if (!parsed.success) {
              terminal.write(String(event.data));
              return;
            }
            const message = parsed.data;
            if (message.type === 'ready') {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
              }
              setStatus('connected');
              terminal.writeln('\x1b[90m已连接。\x1b[0m');
              return;
            }
            if (message.type === 'reauthenticate') {
              void reauthenticate();
              return;
            }
            if (message.type === 'error') {
              setStatus('error');
              setError(consoleErrorMessage(message.code, message.message));
              return;
            }
            if (message.type === 'data' && message.data) terminal.write(message.data);
            if (message.type === 'eof') {
              terminal.writeln(`\r\n\x1b[90m[会话结束，退出码 ${message.exitCode ?? 0}]\x1b[0m`);
              setStatus('closed');
            }
          } catch {
            terminal.write(String(event.data));
          }
        });
        socket.addEventListener('close', (event) => {
          if (cancelled) return;
          const closeMessage = consoleCloseMessage(event.code);
          if (closeMessage) setError(closeMessage);
          setStatus((current) => (closeMessage || current === 'error' ? 'error' : 'closed'));
        });
        socket.addEventListener('error', () => { if (!cancelled) { setStatus('error'); setError('控制台连接失败。'); } });
        disposablesRef.current.push(
          terminal.onData((data) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data })); }),
          terminal.onResize(({ cols, rows }) => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols, rows })); }),
        );
        const resize = () => {
          fit.fit();
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        };
        window.addEventListener('resize', resize);
        disposablesRef.current.push({ dispose: () => window.removeEventListener('resize', resize) });
      } catch (caught) {
        if (!cancelled) {
          setStatus('error');
          setError(caught instanceof Error ? caught.message : '无法打开控制台');
        }
      }
    };
    void connect();
    return () => { cancelled = true; cleanup(); };
  }, [cleanup, consoleEnabled, consoleMessage, container.id, reload, signedIn]);

  const statusLabel: Record<ConsoleStatus, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '已连接',
    closed: '已关闭',
    error: '错误',
  };
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <TerminalIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium">网页终端</span>
          <Badge variant={status === 'connected' ? 'success' : status === 'error' ? 'destructive' : 'secondary'}>{statusLabel[status]}</Badge>
          <span className="truncate font-mono text-xs text-muted-foreground">{container.routedIp ?? '等待容器 IP'}</span>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={() => setReload((value) => value + 1)} disabled={status === 'connecting'}>{status === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}重连</Button>
      </div>
      {error && <div className="break-words border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>}
      <div ref={mountRef} aria-label="网页终端" className="h-[min(24rem,70dvh)] max-w-full overflow-hidden bg-zinc-950 p-2 md:h-[520px]" />
    </div>
  );
}

