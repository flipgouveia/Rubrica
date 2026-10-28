// Save As (CONTRACTS §3 doc_save_as). "Browse" opens the OS save dialog (tauri-plugin-dialog,
// via ./filePicker.ts) and saves straight to the chosen path — the one-click route, and the one
// this dialog existed without until now.
//
// The typed-path field below it stays, for two reasons: there is no OS dialog outside Tauri
// (mock/browser dev), and WebDriver cannot reach an OS-owned window, so it is also what the e2e
// suite drives (see e2e/lib/actions.mjs's `saveAs`).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { commands } from "../ipc";
import type { RubricaError } from "../ipc/bindings";
import { Button, Dialog } from "../tokens/components";
import { useRubricaErrorMessage } from "./errors";
import { browseForSaveTarget, canBrowseFiles } from "./filePicker";
import type { DocId } from "../viewer/types";

interface SaveAsDialogProps {
  docId: DocId;
  /** Where the document currently lives — the native dialog opens in that folder, pre-filled
   *  with that file name, so "save a copy next to the original" is one click. */
  currentPath: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SaveAsDialog({ docId, currentPath, open, onOpenChange }: SaveAsDialogProps) {
  const { t } = useTranslation(["chrome", "common"]);
  const describeError = useRubricaErrorMessage();
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<RubricaError | null>(null);

  function close() {
    onOpenChange(false);
    setPath("");
    setError(null);
  }

  /** Shared by both routes. A failed save now keeps the dialog open and says why, instead of
   *  closing as though it had worked — the result used to be discarded entirely. */
  async function saveTo(destination: string) {
    setSaving(true);
    const result = await commands.docSaveAs(docId, destination);
    setSaving(false);
    if (result.status === "error") setError(result.error);
    else close();
  }

  async function browse() {
    const picked = await browseForSaveTarget(t("chrome:chrome.saveAs.title"), currentPath);
    if (picked) await saveTo(picked);
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <Dialog.Content>
        <Dialog.Title>{t("chrome:chrome.saveAs.title")}</Dialog.Title>
        <Dialog.Description>{t("chrome:chrome.saveAs.description")}</Dialog.Description>
        {canBrowseFiles && (
          <Button className="mt-4 w-full" disabled={saving} onClick={() => void browse()}>
            <FolderOpen className="h-4 w-4" />
            {t("chrome:chrome.saveAs.browse")}
          </Button>
        )}
        <input
          type="text"
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder={t("chrome:chrome.saveAs.pathPlaceholder")}
          className="mt-3 h-10 w-full rounded-sm border border-border-strong bg-surface px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        />
        {error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {describeError(error).description}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button variant="secondary">{t("common:common.actions.cancel")}</Button>
          </Dialog.Close>
          <Button disabled={!path || saving} onClick={() => void saveTo(path)}>
            {t("common:common.actions.save")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
