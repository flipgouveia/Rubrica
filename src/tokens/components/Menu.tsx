import { forwardRef } from "react";
import type { ComponentPropsWithoutRef, ElementRef } from "react";
import * as RadixMenu from "@radix-ui/react-dropdown-menu";
import { clsx } from "clsx";

// Thin, styled wrapper around @radix-ui/react-dropdown-menu. Item labels
// always come from the caller as children — nothing hardcoded here. Radix
// gives full keyboard navigation (arrow keys, type-ahead, Escape) for free.

export const MenuRoot = RadixMenu.Root;
export const MenuTrigger = RadixMenu.Trigger;
export const MenuPortal = RadixMenu.Portal;
export const MenuGroup = RadixMenu.Group;
export const MenuRadioGroup = RadixMenu.RadioGroup;

const itemClasses =
  "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-sm outline-none " +
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground " +
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

const indicatorItemClasses = clsx(itemClasses, "pl-7");

/** Small filled dot used inside the CheckboxItem/RadioItem indicator slot. */
function IndicatorDot() {
  return <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />;
}

export const MenuContent = forwardRef<
  ElementRef<typeof RadixMenu.Content>,
  ComponentPropsWithoutRef<typeof RadixMenu.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <RadixMenu.Portal>
    <RadixMenu.Content
      ref={ref}
      sideOffset={sideOffset}
      className={clsx(
        "z-50 min-w-40 rounded-md border border-border bg-surface-raised p-1 text-text shadow-menu",
        "focus:outline-none",
        className,
      )}
      {...props}
    />
  </RadixMenu.Portal>
));
MenuContent.displayName = "MenuContent";

export const MenuLabel = forwardRef<
  ElementRef<typeof RadixMenu.Label>,
  ComponentPropsWithoutRef<typeof RadixMenu.Label>
>(({ className, ...props }, ref) => (
  <RadixMenu.Label
    ref={ref}
    className={clsx("px-2.5 py-1.5 text-xs font-medium text-muted-text", className)}
    {...props}
  />
));
MenuLabel.displayName = "MenuLabel";

export const MenuSeparator = forwardRef<
  ElementRef<typeof RadixMenu.Separator>,
  ComponentPropsWithoutRef<typeof RadixMenu.Separator>
>(({ className, ...props }, ref) => (
  <RadixMenu.Separator ref={ref} className={clsx("my-1 h-px bg-border", className)} {...props} />
));
MenuSeparator.displayName = "MenuSeparator";

export const MenuItem = forwardRef<
  ElementRef<typeof RadixMenu.Item>,
  ComponentPropsWithoutRef<typeof RadixMenu.Item>
>(({ className, ...props }, ref) => (
  <RadixMenu.Item ref={ref} className={clsx(itemClasses, className)} {...props} />
));
MenuItem.displayName = "MenuItem";

export const MenuCheckboxItem = forwardRef<
  ElementRef<typeof RadixMenu.CheckboxItem>,
  ComponentPropsWithoutRef<typeof RadixMenu.CheckboxItem>
>(({ className, children, ...props }, ref) => (
  <RadixMenu.CheckboxItem ref={ref} className={clsx(indicatorItemClasses, className)} {...props}>
    <RadixMenu.ItemIndicator className="absolute left-2 inline-flex items-center">
      <IndicatorDot />
    </RadixMenu.ItemIndicator>
    {children}
  </RadixMenu.CheckboxItem>
));
MenuCheckboxItem.displayName = "MenuCheckboxItem";

export const MenuRadioItem = forwardRef<
  ElementRef<typeof RadixMenu.RadioItem>,
  ComponentPropsWithoutRef<typeof RadixMenu.RadioItem>
>(({ className, children, ...props }, ref) => (
  <RadixMenu.RadioItem ref={ref} className={clsx(indicatorItemClasses, className)} {...props}>
    <RadixMenu.ItemIndicator className="absolute left-2 inline-flex items-center">
      <IndicatorDot />
    </RadixMenu.ItemIndicator>
    {children}
  </RadixMenu.RadioItem>
));
MenuRadioItem.displayName = "MenuRadioItem";

/** Compound export: `<Menu.Root>`, `<Menu.Trigger>`, `<Menu.Content>`, etc. */
export const Menu = {
  Root: MenuRoot,
  Trigger: MenuTrigger,
  Portal: MenuPortal,
  Content: MenuContent,
  Label: MenuLabel,
  Group: MenuGroup,
  Separator: MenuSeparator,
  Item: MenuItem,
  CheckboxItem: MenuCheckboxItem,
  RadioGroup: MenuRadioGroup,
  RadioItem: MenuRadioItem,
};
