// The two-step "are you sure" gate for `redact_apply` (brief item 4) — deliberately a distinct
// second step from the pending-marks review list itself, not just a variant of it. The copy has
// real work to do: docs/ARCHITECTURE.md calls whiteout-vs-redaction confusion out by name ("the UI
// names the difference"), and this dialog is where that difference has to land before anything
// irreversible-looking happens. Order matters and matches the brief exactly:
//   (a) what redaction does (removes the underlying content + flattens the region to an image)
//   (b) how it differs from whiteout (which only paints over content that still exists underneath)
//   (c) the whole-object-removal caveat (a rect that only clips a line removes the whole line)
//   (d) irreversibility framing (undoable now, on the same undo stack as everything else; gone
//       for good the moment the file is saved)
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../../tokens/components";

export interface ConfirmRedactDialogProps {
  open: boolean;
  /** Number of pending marks the pending redaction would apply — drives the title's pluralization. */
  markCount: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmRedactDialog({ open, markCount, busy, onCancel, onConfirm }: ConfirmRedactDialogProps) {
  const { t } = useTranslation(["tools-redact", "common"]);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Content>
        <Dialog.Title>{t("tools-redact:tools-redact.confirmDialog.title", { count: markCount })}</Dialog.Title>
        <Dialog.Description asChild>
          <div className="mt-2 space-y-3 text-sm text-muted-text">
            <p>{t("tools-redact:tools-redact.confirmDialog.whatItDoes")}</p>
            <p>{t("tools-redact:tools-redact.confirmDialog.vsWhiteout")}</p>
            <p>{t("tools-redact:tools-redact.confirmDialog.wholeObjectCaveat")}</p>
            <p className="font-medium text-text">{t("tools-redact:tools-redact.confirmDialog.irreversibility")}</p>
          </div>
        </Dialog.Description>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common:common.actions.cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={busy}>
            {t("tools-redact:tools-redact.confirmDialog.confirm")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
