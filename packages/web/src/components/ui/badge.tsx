import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-none " +
    "transition-colors [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary/15 text-primary",
        secondary: "border-transparent bg-secondary text-secondary-foreground",
        outline: "border-border text-muted-foreground",
        destructive: "border-transparent bg-destructive/15 text-destructive",
        /** Tinted from a CSS variable so column and priority colors stay in one place. */
        tinted: "border-transparent",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** A CSS color (usually `var(--kind-done)`); drives text and background tint. */
  tint?: string;
}

export const Badge = ({ className, variant, tint, style, ...props }: BadgeProps) => (
  <span
    className={cn(badgeVariants({ variant: tint ? "tinted" : variant }), className)}
    style={
      tint
        ? { color: tint, backgroundColor: `color-mix(in oklab, ${tint} 16%, transparent)`, ...style }
        : style
    }
    {...props}
  />
);
export { badgeVariants };
