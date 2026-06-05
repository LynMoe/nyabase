import type { ContainerAction } from '@nyabase/common';

export function containerActionPath(action: ContainerAction): string {
  return action.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
