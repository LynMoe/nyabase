import { Link } from '@tanstack/react-router';
import { Terminal } from 'lucide-react';
import { ContainerStatus, type ContainerDto } from '@nyabase/common';
import { Button } from '../ui/button.js';
import { Hint } from '../ui/hint.js';

/** Icon button that opens the container's 控制台 tab; disabled while the container is not running. */
export function ConsoleShortcut({ container, admin }: { container: ContainerDto; admin: boolean }) {
  const running = container.actual.status === ContainerStatus.Running;
  if (!running) {
    return (
      <Hint content="容器未运行，无法打开终端" disabled>
        <Button size="icon" variant="ghost" aria-label="打开终端" disabled>
          <Terminal className="h-4 w-4" />
        </Button>
      </Hint>
    );
  }
  return (
    <Hint content="打开终端">
      <Button asChild size="icon" variant="ghost">
        <Link
          to={admin ? '/manage/containers/$containerId' : '/containers/$containerId'}
          params={{ containerId: container.id }}
          search={{ tab: 'console' }}
          aria-label="打开终端"
          data-testid="container-console-shortcut"
        >
          <Terminal className="h-4 w-4" />
        </Link>
      </Button>
    </Hint>
  );
}
