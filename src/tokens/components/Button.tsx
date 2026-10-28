import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render as the single child element instead of a <button> (Radix Slot). */
  asChild?: boolean;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium " +
  "rounded-md transition-colors duration-150 select-none " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:pointer-events-none disabled:opacity-50";

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-sm gap-1.5",
  md: "h-10 px-4 text-[0.9375rem]",
};

const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground hover:bg-accent-hover",
  secondary:
    "border border-border-strong bg-surface text-text hover:bg-border/50",
  ghost: "bg-transparent text-text hover:bg-border/40",
  danger: "bg-danger text-danger-foreground hover:opacity-90",
};

/**
 * Base button primitive. No user-facing strings live here — callers supply
 * `children` (and, for icon-only buttons, use IconButton instead so an
 * accessible name is required at the type level).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = "primary", size = "md", asChild = false, className, children, ...rest }, ref) => {
    const Comp = asChild ? Slot : "button";
    // `type` only exists on native <button>'s attribute set, not on Slot's —
    // route it through a spread (rather than a named JSX attribute) so this
    // stays valid for both branches of the polymorphic `Comp`. Defaulting
    // to "button" avoids an accidental implicit form submit.
    const typeProp = asChild ? {} : { type: rest.type ?? "button" };
    return (
      <Comp
        ref={ref}
        className={clsx(base, sizeClasses[size], variantClasses[variant], className)}
        {...rest}
        {...typeProp}
      >
        {children}
      </Comp>
    );
  },
);
Button.displayName = "Button";
