// Dismiss behaviour shared by the small popovers of the search panel (colour palette, scope
// selector): a pointer-down outside closes, and Escape closes the POPOVER only. Escape is also the
// global "close search" shortcut (a window-level listener), so the key event is stopped here, before
// it reaches the window, when a popover is open.
import { useEffect, useRef, type KeyboardEvent } from "react";

export function useDismissable<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, onClose]);

  const onKeyDown = (event: KeyboardEvent<T>) => {
    if (open && event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  };

  return { ref, onKeyDown };
}
