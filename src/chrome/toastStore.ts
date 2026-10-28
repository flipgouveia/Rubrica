// Lightweight, app-wide transient notices (save failed, print failed, ...). Blocking failures
// that need the user's full attention (open failed: encrypted/corrupt) use a Dialog instead —
// see HomeScreen's OpenErrorDialog. Rendered by <ToastHost/> in AppShell.
import { create } from "zustand";

export interface Toast {
  id: string;
  tone: "danger" | "info" | "success";
  title: string;
  description?: string;
  /** Optional single action button (e.g. "Install and restart") — R7's updater notice. */
  actionLabel?: string;
  onAction?: () => void;
}

interface ToastState {
  toasts: Toast[];
}

let counter = 0;

export const useToastStore = create<ToastState>(() => ({ toasts: [] }));

export function pushToast(toast: Omit<Toast, "id">): string {
  const id = `toast-${++counter}`;
  useToastStore.setState((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
  window.setTimeout(() => dismissToast(id), 5000);
  return id;
}

export function dismissToast(id: string): void {
  useToastStore.setState((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }));
}
