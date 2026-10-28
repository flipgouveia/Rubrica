import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { clsx } from "clsx";
import { IconButton } from "../tokens/components";
import { dismissToast, useToastStore } from "./toastStore";

const TONE_CLASSES: Record<string, string> = {
  danger: "border-danger/40 bg-danger/10 text-danger",
  info: "border-border-strong bg-surface-raised text-text",
  success: "border-success/40 bg-success/10 text-success",
};

/** Mounted once (AppShell). Renders transient toasts pushed via `pushToast`. */
export function ToastHost() {
  const { t } = useTranslation("common");
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div key={toast.id} className={clsx("pointer-events-auto flex w-80 items-start gap-2 rounded-md border p-3 shadow-menu", TONE_CLASSES[toast.tone])}>
          <div className="flex-1">
            <p className="text-sm font-medium">{toast.title}</p>
            {toast.description && <p className="mt-0.5 text-xs opacity-90">{toast.description}</p>}
            {toast.onAction && (
              <button
                type="button"
                className="mt-1.5 text-xs font-medium underline underline-offset-2"
                onClick={() => {
                  toast.onAction?.();
                  dismissToast(toast.id);
                }}
              >
                {toast.actionLabel}
              </button>
            )}
          </div>
          <IconButton aria-label={t("common:common.actions.close")} size="sm" onClick={() => dismissToast(toast.id)}>
            <X className="h-4 w-4" />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
