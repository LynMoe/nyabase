import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, RotateCw, Terminal as TerminalIcon } from 'lucide-react';
import type { IDisposable } from '@xterm/xterm';
import { zConsoleToBrowser, type ContainerDto, type ExecSessionResponse } from '@nyabase/common';
import { api } from '../../lib/api.js';
import { useAuthStore } from '../../store/auth.js';
import { Button } from '../ui/button.js';
import { Badge } from '../ui/badge.js';

type ConsoleStatus = 'idle' | 'connecting' | 'connected' | 'closed' | 'error';

export function ContainerConsole({
  container,
  admin = false,
}: {
  container: ContainerDto;
  admin?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const disposablesRef = useRef<IDisposable[]>([]);
  const [status, setStatus] = useState<ConsoleStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const token = useAuthStore((state) => state.accessToken);

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
      if (!token || !container.actions.console.enabled || !mountRef.current) {
        setStatus('error');
        setError(!token ? '登录已失效，请重新登录。' : container.actions.console.message ?? '当前容器不能打开控制台。');
        return;
      }
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
          theme: { background: '#09090b', foreground: '#f4f4f5', cursor: '#f4f4f5' },
        });
        const fit = new FitAddon();
        terminal.loadAddon(fit);
        terminal.loadAddon(new WebLinksAddon());
        terminal.open(mountRef.current);
        fit.fit();
        terminalRef.current = terminal;
        fitRef.current = fit;
        terminal.writeln('\x1b[90m正在连接控制台...\x1b[0m');
        const base = admin ? `/admin/containers/${container.id}` : `/containers/${container.id}`;
        const session = await api.post<ExecSessionResponse>(`${base}/exec-sessions`, { tty: true, cols: terminal.cols || 100, rows: terminal.rows || 30 });
        if (cancelled) return;
        const resolved = new URL(session.consoleUrl, window.location.href);
        if (resolved.protocol === 'http:') resolved.protocol = 'ws:';
        if (resolved.protocol === 'https:') resolved.protocol = 'wss:';
        if (resolved.protocol !== 'ws:' && resolved.protocol !== 'wss:') throw new Error('控制台地址无效。');
        const socket = new WebSocket(resolved.toString());
        socketRef.current = socket;
        socket.addEventListener('open', () => {
          socket.send(JSON.stringify({ type: 'auth', token }));
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
            if (message.type === 'error') {
              setStatus('error');
              setError(message.message || '控制台错误。');
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
        socket.addEventListener('close', () => {
          if (!cancelled) setStatus((current) => (current === 'error' ? current : 'closed'));
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
  }, [admin, cleanup, container.actions.console, container.id, reload, token]);

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

