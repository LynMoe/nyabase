import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Button } from './ui/button.js';

interface ErrorBoundaryProps {
  children: ReactNode;
  // Custom fallback render. Receives error and a reset() to clear the boundary state.
  fallback?: (error: Error, reset: () => void) => ReactNode;
  // Optional context label included in console output (e.g. "Root", "RouterShell").
  scope?: string;
  // Notified whenever an error is caught.
  onError?: (error: Error, info: ErrorInfo) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const scope = this.props.scope ?? 'ErrorBoundary';
    console.error(`[${scope}] caught error:`, error, info.componentStack);
    this.props.onError?.(error, info);
  }

  private reset = () => this.setState({ error: null });

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) return this.props.fallback(error, this.reset);

    return (
      <div className="min-h-[60vh] w-full flex items-center justify-center p-6">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              <CardTitle className="text-lg">页面出错了</CardTitle>
            </div>
            <CardDescription>
              抱歉，页面渲染时发生异常。可以尝试刷新页面恢复。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <pre className="max-h-40 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground whitespace-pre-wrap break-words">
              {error.message || String(error)}
            </pre>
            <div className="flex gap-2 justify-end">
              <Button variant="outline" size="sm" onClick={this.reset}>
                重试
              </Button>
              <Button size="sm" onClick={() => window.location.reload()}>
                <RefreshCw className="h-4 w-4" />
                刷新页面
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }
}
