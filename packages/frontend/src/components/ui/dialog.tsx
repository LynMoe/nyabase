import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/utils.js';
import { useScrollOverflow } from '../../hooks/use-scroll-overflow.js';

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

function hasDialogDescription(children: React.ReactNode): boolean {
  return React.Children.toArray(children).some((child) => {
    if (!React.isValidElement<{ children?: React.ReactNode }>(child)) return false;
    const type = child.type as { displayName?: string } | undefined;
    return type?.displayName === DialogPrimitive.Description.displayName
      || hasDialogDescription(child.props.children);
  });
}

function flattenNodes(children: React.ReactNode): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  for (const node of React.Children.toArray(children)) {
    if (React.isValidElement(node) && node.type === React.Fragment) {
      out.push(...flattenNodes((node.props as { children?: React.ReactNode }).children));
    } else {
      out.push(node);
    }
  }
  return out;
}

function splitDialogSlots(children: React.ReactNode) {
  const header: React.ReactNode[] = [];
  const footer: React.ReactNode[] = [];
  const body: React.ReactNode[] = [];
  for (const node of flattenNodes(children)) {
    if (!React.isValidElement(node)) {
      body.push(node);
      continue;
    }
    const name = (node.type as { displayName?: string }).displayName;
    if (name === 'DialogHeader') header.push(node);
    else if (name === 'DialogFooter') footer.push(node);
    else body.push(node);
  }
  return { header, footer, body };
}

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      'fixed inset-0 z-50 bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const describedByProps = hasDialogDescription(children)
    ? {}
    : { 'aria-describedby': undefined };
  const { header, footer, body } = splitDialogSlots(children);
  const [bodyRef, overflow] = useScrollOverflow('y');

  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          'fixed z-50 grid min-h-0 border bg-background shadow-lg duration-200',
          'inset-x-4 top-4 h-[calc(100dvh-2rem)] w-auto translate-x-0 translate-y-0',
          'sm:inset-auto sm:left-[50%] sm:top-[50%] sm:h-[min(max-content,min(90dvh,calc(100dvh-2rem)))] sm:max-h-[min(90dvh,calc(100dvh-2rem))] sm:w-[calc(100%-2rem)] sm:max-w-lg sm:translate-x-[-50%] sm:translate-y-[-50%] sm:rounded-lg',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%] data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
          className,
          'overflow-hidden',
        )}
        style={{ gridTemplateRows: 'auto minmax(0, 1fr) auto' }}
        {...describedByProps}
        {...props}
      >
        {header.length > 0 && (
          <div className="shrink-0 px-6 pb-2 pt-6 pr-12">{header}</div>
        )}
        {body.length > 0 ? (
          <div className="relative min-h-0 overflow-hidden">
            <div
              ref={bodyRef}
              className="h-full min-h-0 space-y-4 overflow-y-auto overscroll-contain px-6 py-4 pb-8"
            >
              {body}
            </div>
            {overflow.end && (
              <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 bg-gradient-to-t from-background to-transparent" />
            )}
            {overflow.start && (
              <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-gradient-to-b from-background to-transparent" />
            )}
          </div>
        ) : (
          <div />
        )}
        {footer.length > 0 ? (
          <div className="relative z-10 border-t bg-background px-6 py-4">{footer}</div>
        ) : (
          <div />
        )}
        <DialogClose className="absolute right-4 top-4 z-20 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground">
          <X className="h-4 w-4" />
          <span className="sr-only">关闭</span>
        </DialogClose>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
});
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props} />
);
DialogHeader.displayName = 'DialogHeader';

const DialogFooter = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:space-x-2', className)} {...props} />
);
DialogFooter.displayName = 'DialogFooter';

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold leading-none tracking-tight', className)}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('break-keep text-sm text-muted-foreground', className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog, DialogPortal, DialogOverlay, DialogClose, DialogTrigger,
  DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
};
