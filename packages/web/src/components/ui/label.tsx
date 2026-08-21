import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

export const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root> & { hint?: string }
>(({ className, hint, children, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      "flex items-baseline gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground",
      "peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className,
    )}
    {...props}
  >
    {children}
    {hint ? <span className="font-normal normal-case tracking-normal text-muted-foreground/70">{hint}</span> : null}
  </LabelPrimitive.Root>
));
Label.displayName = "Label";
