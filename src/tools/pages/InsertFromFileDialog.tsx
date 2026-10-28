import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PageRange } from "../../ipc/bindings";
import { Button, Dialog } from "../../tokens/components";

export interface InsertFromFileDialogProps {
  open: boolean;
  busy: boolean;
  onCancel: () => void;
  /**
   * `file` is the browser `File` the user picked — per the brief, this is a
   * mock/browser-only simulation of a native file-dialog (no Tauri file
   * API is available on the mock side): only `file.name` is ever read,
   * standing in for the real absolute path `pages_insert_from_file` wants.
   * Bytes are deliberately never touched (out of scope — the mock fabricates
   * placeholder pages from the name alone).
   */
  onConfirm: (file: File, range: PageRange | null) => void;
}

/**
 * "Insert from another PDF" (brief item 2): a plain `<input type="file">`
 * standing in for a native file picker, plus an optional page-range control
 * — `null` range means "whole file" per `pages_insert_from_file`'s own
 * documented convention (mock/pages.ts: `range ? max(1, end-start+1) : 1`).
 */
export function InsertFromFileDialog({ open, busy, onCancel, onConfirm }: InsertFromFileDialogProps) {
  const { t } = useTranslation(["tools-pages", "common"]);
  const [file, setFile] = useState<File | null>(null);
  const [rangeEnabled, setRangeEnabled] = useState(false);
  const [rangeStart, setRangeStart] = useState("1");
  const [rangeEnd, setRangeEnd] = useState("1");

  useEffect(() => {
    if (!open) {
      setFile(null);
      setRangeEnabled(false);
      setRangeStart("1");
      setRangeEnd("1");
    }
  }, [open]);

  function handleConfirm() {
    if (!file) return;
    let range: PageRange | null = null;
    if (rangeEnabled) {
      const start = Math.max(1, Number.parseInt(rangeStart, 10) || 1);
      const end = Math.max(start, Number.parseInt(rangeEnd, 10) || start);
      range = { start: start - 1, end: end - 1 };
    }
    onConfirm(file, range);
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <Dialog.Content>
        <Dialog.Title>{t("tools-pages:tools-pages.insertFileDialog.title")}</Dialog.Title>

        <div className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-text" htmlFor="pages-insert-file-input">
              {t("tools-pages:tools-pages.insertFileDialog.fileLabel")}
            </label>
            <input
              id="pages-insert-file-input"
              type="file"
              accept="application/pdf"
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              className="w-full text-sm text-text file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text file:hover:bg-border/40"
            />
            {!file && <p className="text-xs text-muted-text">{t("tools-pages:tools-pages.insertFileDialog.noFileChosen")}</p>}
          </div>

          <label className="flex items-center gap-2 text-sm text-text">
            <input
              type="checkbox"
              checked={rangeEnabled}
              onChange={(event) => setRangeEnabled(event.target.checked)}
              className="h-4 w-4 rounded border-border-strong"
            />
            {t("tools-pages:tools-pages.insertFileDialog.rangeToggle")}
          </label>

          {rangeEnabled && (
            <div className="flex items-center gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-text" htmlFor="pages-insert-range-start">
                  {t("tools-pages:tools-pages.insertFileDialog.rangeStart")}
                </label>
                <input
                  id="pages-insert-range-start"
                  type="number"
                  min={1}
                  value={rangeStart}
                  onChange={(event) => setRangeStart(event.target.value)}
                  className="w-20 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm text-text"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs text-muted-text" htmlFor="pages-insert-range-end">
                  {t("tools-pages:tools-pages.insertFileDialog.rangeEnd")}
                </label>
                <input
                  id="pages-insert-range-end"
                  type="number"
                  min={1}
                  value={rangeEnd}
                  onChange={(event) => setRangeEnd(event.target.value)}
                  className="w-20 rounded-md border border-border-strong bg-surface px-2 py-1 text-sm text-text"
                />
              </div>
            </div>
          )}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {t("common:common.actions.cancel")}
          </Button>
          <Button variant="primary" onClick={handleConfirm} disabled={busy || !file}>
            {t("tools-pages:tools-pages.insertFileDialog.confirm")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
