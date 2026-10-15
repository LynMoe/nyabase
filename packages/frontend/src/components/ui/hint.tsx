import type { ReactElement, ReactNode } from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip.js';

/**
 * Tooltip that also works on disabled controls. A disabled button swallows
 * pointer and focus events, so when `disabled` is set the trigger becomes a
 * focusable wrapper instead of the control. Prefer this over `title=` for
 * anything the user needs to read, such as why an action is unavailable.
 */
export function Hint({
  content,
  disabled = false,
  children,
}: {
  content?: ReactNode;
  disabled?: boolean;
  children: ReactElement;
}) {
  if (!content) return children;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          {disabled ? (
            <span tabIndex={0} className="inline-flex rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {children}
            </span>
          ) : children}
        </TooltipTrigger>
        <TooltipContent>{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
