import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw, Terminal as TerminalIcon } from 'lucide-react';
import type { IDisposable } from '@xterm/xterm';
import type { ContainerView, ExecSessionResponse } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { useAuthStore } from '../../store/auth.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';

type ConsoleStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

interface ConsoleMessage {
  type: 'data' | 'eof';
  data?: string;
  stderr?: boolean;
  exitCode?: number;
}

function wsUrl(consoleUrl: string): string {
  const resolved = new URL(consoleUrl, window.location.href);
  if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
  if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
  if (resolved.protocol !== 'ws:' && resolved.protocol !== 'wss:') {
    throw new Error('控制台地址无效。');
  }
  return resolved.toString();
}

function decodeBase64(data: string): string {
  try {
    const binary = window.atob(data);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return data;
  }
}

export function ContainerConsole({
  container,
  apiBasePath = '/v2/containers',
}: {
  container: ContainerView;
  apiBasePath?: string;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const [status, setStatus] = useState<ConsoleStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const token = useAuthStore((s) => s.accessToken);
  const ip = container.runtime.ip ?? '等待运行态';

  const cleanup = useCallback(() => {
    for (const disposable of disposablesRef.current) disposable.dispose();
    disposablesRef.current = [];
    wsRef.current?.close(1000, 'component cleanup');
    wsRef.current = null;
    terminalRef.current?.dispose();
    terminalRef.current = null;
    fitRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      cleanup();
      setStatus('connecting');
      setError(null);

      if (!token) {
        setStatus('error');
        setError('登录已失效，请重新登录后再打开控制台。');
        return;
      }
      if (!container.actions.console.enabled) {
        setStatus('error');
        setError(container.actions.console.message ?? '当前容器不能打开控制台。');
        return;
      }
      if (!mountRef.current) return;

      try {
        const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
          import('@xterm/addon-web-links'),
          import('@xterm/xterm/css/xterm.css'),
        ]);
        if (cancelled || !mountRef.current) return;

        const terminal = new Terminal({
          cursorBlink: true,
          convertEol: true,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          fontSize: 13,
          theme: {
            background: '#09090b',
            foreground: '#f4f4f5',
            cursor: '#f4f4f5',
          },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.loadAddon(new WebLinksAddon());
        terminal.open(mountRef.current);
        fit.fit();
        terminalRef.current = terminal;
        fitRef.current = fit;
        terminal.writeln('\x1b[90m正在创建容器控制台会话...\x1b[0m');

        const cols = Math.max(1, terminal.cols || 100);
        const rows = Math.max(1, terminal.rows || 30);
        const session = await api.post<ExecSessionResponse>(`${apiBasePath}/${container.id}/exec-sessions`, {
          tty: true,
          cols,
          rows,
        });
        if (cancelled) return;

        const ws = new WebSocket(wsUrl(session.consoleUrl));
        wsRef.current = ws;

        ws.addEventListener('open', () => {
          ws.send(JSON.stringify({ type: 'auth', token }));
          setStatus('connected');
          terminal.writeln('\x1b[90m已连接，正在进入 shell...\x1b[0m');
          ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
        });
        ws.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(String(event.data)) as ConsoleMessage;
            if (message.type === 'data' && message.data) {
              terminal.write(decodeBase64(message.data));
            } else if (message.type === 'eof') {
              terminal.writeln(`\r\n\x1b[90m[会话结束，退出码 ${message.exitCode ?? 0}]\x1b[0m`);
              setStatus('closed');
            }
          } catch {
            terminal.write(String(event.data));
          }
        });
        ws.addEventListener('close', (event) => {
          if (cancelled) return;
          setStatus((prev) => (prev === 'error' ? prev : 'closed'));
          if (event.code !== 1000) {
            terminal.writeln(`\r\n\x1b[31m[控制台连接关闭：${event.reason || event.code}]\x1b[0m`);
          }
        });
        ws.addEventListener('error', () => {
          if (cancelled) return;
          setStatus('error');
          setError('控制台 WebSocket 连接失败。');
        });

        disposablesRef.current.push(
          terminal.onData((data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data }));
            }
          }),
          terminal.onResize(({ cols: resizedCols, rows: resizedRows }) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'resize', cols: resizedCols, rows: resizedRows }));
            }
          }),
        );

        const handleResize = () => {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
          }
        };
        window.addEventListener('resize', handleResize);
        disposablesRef.current.push({ dispose: () => window.removeEventListener('resize', handleResize) });
      } catch (err) {
        if (cancelled) return;
        setStatus('error');
        setError(err instanceof Error ? err.message : String(err));
      }
    }

    void start();
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [apiBasePath, cleanup, container.actions.console, container.id, nonce, token]);

  const statusLabel: Record<ConsoleStatus, string> = {
    idle: '未连接',
    connecting: '连接中',
    connected: '已连接',
    closed: '已关闭',
    error: '错误',
  };

  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm font-medium">Shell</span>
          <Badge variant={status === 'connected' ? 'success' : status === 'error' ? 'destructive' : 'secondary'}>{statusLabel[status]}</Badge>
          <span className="text-xs text-muted-foreground">容器 IP</span>
          <span className="font-mono text-xs text-foreground">{ip}</span>
        </div>
        <Button size="sm" variant="outline" onClick={() => setNonce((v) => v + 1)} disabled={status === 'connecting'}>
          {status === 'connecting' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCw className="h-4 w-4" />}
          重连
        </Button>
      </div>
      {error && <div className="border-b bg-destructive/10 px-4 py-2 text-xs text-destructive">{error}</div>}
      <div ref={mountRef} aria-label="Shell" className="h-[520px] bg-zinc-950 p-2" />
    </div>
  );
}
