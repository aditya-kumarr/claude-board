import * as React from "react";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as ProgressPrimitive from "@radix-ui/react-progress";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

export const Separator = React.forwardRef<
  React.ElementRef<typeof SeparatorPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SeparatorPrimitive.Root>
>(({ className, orientation = "horizontal", decorative = true, ...props }, ref) => (
  <SeparatorPrimitive.Root
    ref={ref}
    decorative={decorative}
    orientation={orientation}
    className={cn("shrink-0 bg-border", orientation === "horizontal" ? "h-px w-full" : "h-full w-px", className)}
    {...props}
  />
));
Separator.displayName = "Separator";

/** Progress bar whose fill color is caller-controlled, for deadline urgency. */
export const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & { indicatorColor?: string }
>(({ className, value, indicatorColor, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className="h-full w-full flex-1 rounded-full transition-transform duration-500 ease-out"
      style={{
        transform: `translateX(-${100 - Math.min(100, Math.max(0, value ?? 0))}%)`,
        backgroundColor: indicatorColor ?? "var(--primary)",
      }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = "Progress";

export const Avatar = ({
  name,
  tint,
  size = "md",
  className,
}: {
  name: string;
  tint?: string;
  size?: "sm" | "md";
  className?: string;
}) => {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <AvatarPrimitive.Root
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold ring-1 ring-inset",
        size === "sm" ? "size-5 text-[9px]" : "size-6 text-[10px]",
        className,
      )}
      style={{
        color: tint ?? "var(--muted-foreground)",
        backgroundColor: `color-mix(in oklab, ${tint ?? "var(--muted-foreground)"} 18%, transparent)`,
        // @ts-expect-error CSS custom property for the ring color
        "--tw-ring-color": `color-mix(in oklab, ${tint ?? "var(--muted-foreground)"} 35%, transparent)`,
      }}
      title={name}
    >
      <AvatarPrimitive.Fallback>{initials}</AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
};

export const Skeleton = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />
);

/** Consistent empty state so blank columns and blank boards look intentional. */
export const EmptyState = ({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) => (
  <div
    className={cn(
      "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border/70 px-4 py-8 text-center",
      className,
    )}
  >
    {icon ? <div className="text-muted-foreground/60 [&_svg]:size-5">{icon}</div> : null}
    <p className="text-sm font-medium text-muted-foreground">{title}</p>
    {hint ? <p className="max-w-56 text-xs text-muted-foreground/70">{hint}</p> : null}
    {action}
  </div>
);
