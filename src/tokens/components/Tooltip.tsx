import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import * as RadixTooltip from "@radix-ui/react-tooltip";
import { clsx } from "clsx";

// Thin, styled wrapper around @radix-ui/react-tooltip. Content is always
// supplied by the caller (usually the same string as the paired
// IconButton's aria-label) — nothing hardcoded here. Inverted surface
// (dark chip in light mode, light chip in dark mode) gives it a distinct
// look instead of a stock library tooltip.

export const TooltipProvider = RadixTooltip.Provider;
export const TooltipRoot = RadixTooltip.Root;
export const TooltipTrigger = RadixTooltip.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof RadixTooltip.Content>,
  ComponentPropsWithoutRef<typeof RadixTooltip.Content>
>(({ className, sideOffset = 6, children, ...props }, ref) => (
  <RadixTooltip.Portal>
    <RadixTooltip.Content
      ref={ref}
      sideOffset={sideOffset}
      className={clsx(
        "z-50 select-none rounded-sm bg-text px-2.5 py-1.5 text-xs font-medium text-background shadow-menu",
        className,
      )}
      {...props}
    >
      {children}
      <RadixTooltip.Arrow className="fill-text" />
    </RadixTooltip.Content>
  </RadixTooltip.Portal>
));
TooltipContent.displayName = "TooltipContent";

/** Compound export: `<Tooltip.Provider>`, `<Tooltip.Root>`, etc. */
export const Tooltip = {
  Provider: TooltipProvider,
  Root: TooltipRoot,
  Trigger: TooltipTrigger,
  Content: TooltipContent,
};
