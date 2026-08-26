import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A dialog pinned to the right edge, full height.
 *
 * Same primitive as `Dialog`, different geometry, and the difference carries
 * meaning: a sheet is a place to work *on* something that is still on screen
 * behind it, which is exactly the reply panel's relationship to its card. Radix
 * stacks nested dialogs, so opening one from inside a dialog is fine — Escape
 * closes the sheet first.
 */
export const Sheet = DialogPrimitive.Root;
export const SheetClose = DialogPrimitive.Close;
export const SheetTitle = DialogPrimitive.Title;
export const SheetDescription = DialogPrimitive.Description;

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { hideClose?: boolean }
>(({ className, children, hideClose, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]",
        "data-[state=open]:animate-[fadeIn_150ms_ease-out] data-[state=closed]:animate-[fadeOut_120ms_ease-in]",
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col",
        "border-l border-border bg-elevated shadow-2xl",
        "data-[state=open]:animate-[sheetIn_220ms_cubic-bezier(0.16,1,0.3,1)]",
        "data-[state=closed]:animate-[sheetOut_150ms_ease-in]",
        className,
      )}
      {...props}
    >
      {children}
      {hideClose ? null : (
        <DialogPrimitive.Close
          className="absolute right-3.5 top-3.5 rounded-sm p-1 text-muted-foreground opacity-70 transition-opacity hover:bg-muted hover:opacity-100"
          aria-label="Close"
        >
          <X className="size-4" />
        </DialogPrimitive.Close>
      )}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
SheetContent.displayName = "SheetContent";
