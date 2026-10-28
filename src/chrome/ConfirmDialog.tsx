// Generic confirm/cancel modal (close unsaved tab today; reusable by future tool packages for
// "delete N pages"-style confirms per their own briefs). Thin composition of the shared Dialog
// primitive from src/tokens — no new primitive added there, which stays read-only for R3.
import { useTranslation } from "react-i18next";
import { Dialog } from "../tokens/components";
import { Button } from "../tokens/components";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: "default" | "danger";
  onConfirm: () => void;
}

export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, tone = "default", onConfirm }: ConfirmDialogProps) {
  const { t } = useTranslation("common");
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description>{description}</Dialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button variant="secondary">{t("common:common.actions.cancel")}</Button>
          </Dialog.Close>
          <Button
            variant={tone === "danger" ? "danger" : "primary"}
            onClick={() => {
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel ?? t("common:common.actions.confirm")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
