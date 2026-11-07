import * as DialogPrimitive from '@radix-ui/react-dialog';
import { Button } from './button';
import { X } from 'lucide-react';
import { useRef, type ComponentProps } from 'react';
import { cn } from '../../lib/utils';
export const Dialog = DialogPrimitive.Root;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;
export function DialogContent({
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>) {
  const previous = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/65 backdrop-blur-sm" />
      <DialogPrimitive.Content
        className={cn(
          'fixed left-1/2 top-1/2 z-50 max-h-[90vh] overflow-y-auto w-[min(560px,90vw)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-7 shadow-2xl outline-none',
          className,
        )}
        {...props}
        onOpenAutoFocus={(event) => {
          previous.current = document.activeElement as HTMLElement | null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (event.defaultPrevented) return;
          event.preventDefault();
          const target = previous.current;
          if (target?.isConnected) target.focus();
          else
            document.querySelector<HTMLTextAreaElement>('textarea[aria-label="分析需求"]')?.focus();
        }}
      >
        {children}
        <DialogPrimitive.Close asChild>
          <Button
            size="icon"
            variant="ghost"
            className="absolute right-4 top-4"
            aria-label="关闭对话框"
          >
            <X size={18} />
          </Button>
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}
