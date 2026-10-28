import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../../tokens/components";

export interface DeleteConfirmDialogProps {
  open: boolean;
  /** Number of pages the pending delete would remove. */
  count: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * Confirmation gate for `pages_delete` (brief item 2: "delete (with count
 * confirm)") — states the exact page count being removed before anything
 * irreversible-looking happens. The mock itself still guards against
 * deleting every page of a document (INVALID_ARG); `PagesPanel` is
 * responsible for surfacing that error afterwards, this dialog only ever
 * decides whether to ask the backend at all.
 */
export function DeleteConfirmDialog({ open, count, busy, onCancel, onConfirm }: DeleteConfirmDialogProps) {
  const { t } = useTranslation(["tools-pages", "common"]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Content>
        <Dialog.Title>{t("tools-pages:tools-pages.deleteDialog.title", { count })}</Dialog.Title>
        <Dialog.Description>{t("tools-pages:tools-pages.deleteDialog.body", { count })}</Dialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common:common.actions.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {t("common:common.actions.delete")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
