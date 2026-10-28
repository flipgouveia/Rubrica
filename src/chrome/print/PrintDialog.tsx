// Print flow dialog (brief item 4: "dialog (page range, per contract print_render) -> hidden
// print window"). Always calls the real `print_render` command per CONTRACTS §3 regardless of
// engine — the mock returns fake paths and the actual preview image comes from the tile
// pipeline instead (see printWindow.ts), but the IPC call itself is exercised identically to
// the real engine so nothing here needs to change once R2's implementation lands. The real
// engine's pages reach the hidden print window through the `rubrica-print` protocol.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "../../ipc";
import { Button, Dialog } from "../../tokens/components";
import type { DocId } from "../../viewer/types";
import { pushToast } from "../toastStore";
import { useRubricaErrorMessage } from "../errors";
import { openPrintWindow } from "./printWindow";

type RangeMode = "all" | "current" | "range";

interface PrintDialogProps {
  docId: DocId;
  pageCount: number;
  currentPage: number;
  revision: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function parseRange(text: string, pageCount: number): number[] {
  const pages = new Set<number>();
  for (const part of text.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const match = /^(\d+)(?:-(\d+))?$/.exec(trimmed);
    if (!match) continue;
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : start;
    for (let page = start; page <= end; page++) {
      if (page >= 1 && page <= pageCount) pages.add(page - 1);
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

const PRINT_DPI = 150;

export function PrintDialog({ docId, pageCount, currentPage, revision, open, onOpenChange }: PrintDialogProps) {
  const { t } = useTranslation(["chrome", "common"]);
  const errorMessage = useRubricaErrorMessage();
  const [mode, setMode] = useState<RangeMode>("all");
  const [rangeText, setRangeText] = useState("");
  const [printing, setPrinting] = useState(false);

  const resolvePages = (): number[] => {
    if (mode === "current") return [currentPage];
    if (mode === "all") return Array.from({ length: pageCount }, (_, i) => i);
    return parseRange(rangeText, pageCount);
  };

  const handlePrint = async () => {
    const pages = resolvePages();
    if (pages.length === 0) return;
    setPrinting(true);
    const result = await commands.printRender(docId, pages, PRINT_DPI);
    setPrinting(false);
    if (result.status === "error") {
      const message = errorMessage(result.error);
      pushToast({ tone: "danger", title: message.title, description: message.description });
      return;
    }
    onOpenChange(false);
    // The rendered files stay under print_render's temp dir; the page images are fetched through
    // the `rubrica-print` protocol by (docId, page, dpi), never by a path from here.
    const printed = await openPrintWindow(docId, pages, revision, PRINT_DPI);
    if (!printed) pushToast({ tone: "danger", title: t("chrome:chrome.print.failed") });
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content>
        <Dialog.Title>{t("chrome:chrome.print.title")}</Dialog.Title>
        <Dialog.Description>{t("chrome:chrome.print.description")}</Dialog.Description>

        <fieldset className="mt-4 flex flex-col gap-2">
          <legend className="sr-only">{t("chrome:chrome.print.rangeLegend")}</legend>
          {(["all", "current", "range"] as const).map((option) => (
            <label key={option} className="flex items-center gap-2 text-sm text-text">
              <input type="radio" name="print-range" checked={mode === option} onChange={() => setMode(option)} />
              {t(`chrome:chrome.print.mode.${option}`)}
            </label>
          ))}
          {mode === "range" && (
            <input
              type="text"
              value={rangeText}
              onChange={(e) => setRangeText(e.target.value)}
              placeholder={t("chrome:chrome.print.rangePlaceholder")}
              className="ml-6 h-9 rounded-sm border border-border-strong bg-surface px-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          )}
        </fieldset>

        <div className="mt-5 flex justify-end gap-2">
          <Dialog.Close asChild>
            <Button variant="secondary">{t("common:common.actions.cancel")}</Button>
          </Dialog.Close>
          <Button disabled={printing} onClick={() => void handlePrint()}>
            {t("chrome:chrome.print.action")}
          </Button>
        </div>
      </Dialog.Content>
    </Dialog.Root>
  );
}
