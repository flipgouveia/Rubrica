import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";

export type IconButtonVariant = "ghost" | "solid" | "danger";
export type IconButtonSize = "sm" | "md";

export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> {
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  /** Render as the single child element instead of a <button> (Radix Slot). */
  asChild?: boolean;
  /**
   * Icon buttons carry no visible text, so an accessible name is required
   * at the type level — every call site must pass one (through i18n).
   */
  "aria-label": string;
  /** The icon itself (an inline SVG, typically). */
  children: ReactNode;
}

const base =
  "inline-flex shrink-0 items-center justify-center rounded-sm transition-colors duration-150 " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring " +
  "focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "disabled:pointer-events-none disabled:opacity-50";

const sizeClasses: Record<IconButtonSize, string> = {
  sm: "h-8 w-8 [&_svg]:h-4 [&_svg]:w-4",
  md: "h-9 w-9 [&_svg]:h-[1.125rem] [&_svg]:w-[1.125rem]",
};

const variantClasses: Record<IconButtonVariant, string> = {
  ghost:
    "bg-transparent text-text hover:bg-border/50 aria-pressed:bg-accent/15 aria-pressed:text-accent",
  solid: "border border-border-strong bg-surface text-text hover:bg-border/40",
  danger: "bg-transparent text-danger hover:bg-danger/10",
};

/**
 * Icon-only button primitive (toolbar buttons, panel controls). Distinct
 * from Button because it enforces `aria-label` — there is no text child to
 * fall back on for assistive tech.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ variant = "ghost", size = "md", asChild = false, className, children, ...rest }, ref) => {
    const Comp = asChild ? Slot : "button";
    // See Button.tsx: `type` is routed through a spread, not a named JSX
    // attribute, so it type-checks for both the Slot and <button> branches.
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
IconButton.displayName = "IconButton";
