import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Adds a subtle press-down transform and a `loading` state to the stock shadcn
 * button, since almost every action here is an async write.
 */
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium " +
    "transition-[background-color,box-shadow,transform,color] duration-150 outline-none " +
    "disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] " +
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:brightness-110 " +
          "hover:shadow-[0_2px_12px_-2px_color-mix(in_oklab,var(--primary)_55%,transparent)]",
        secondary: "bg-secondary text-secondary-foreground hover:bg-muted",
        outline: "border border-border bg-transparent hover:bg-muted/70 hover:border-ring/40",
        ghost: "hover:bg-muted/70 text-muted-foreground hover:text-foreground",
        destructive: "bg-destructive text-destructive-foreground shadow-sm hover:brightness-110",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-[13px] rounded-md",
        xs: "h-7 px-2 text-xs rounded-sm gap-1.5 [&_svg]:size-3.5",
        lg: "h-11 px-6",
        icon: "size-9",
        "icon-sm": "size-7 rounded-sm [&_svg]:size-3.5",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, loading = false, children, disabled, ...props }, ref) => {
    if (asChild) {
      return (
        <Slot className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props}>
          {children}
        </Slot>
      );
    }
    return (
      <button
        className={cn(buttonVariants({ variant, size }), className)}
        ref={ref}
        disabled={disabled || loading}
        {...props}
      >
        {loading ? <Loader2 className="animate-spin" /> : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
export { buttonVariants };
