import * as React from "react";
import { cn } from "@/lib/utils";

/** Focus ring is a soft inset shadow rather than an outline, so it reads calmer in a dense form. */
const fieldClasses =
  "w-full rounded-md border border-input bg-background/60 px-3 text-sm text-foreground " +
  "placeholder:text-muted-foreground/70 transition-[box-shadow,border-color] " +
  "focus:border-ring focus:outline-none focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--ring)_22%,transparent)] " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(fieldClasses, "h-9", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(fieldClasses, "min-h-20 py-2 leading-relaxed resize-y", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export { fieldClasses };
