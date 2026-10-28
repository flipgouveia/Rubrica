// The redact tool's side panel (TOOL-API.md's `panel` slot, brief items 1b/3/4): "mark selection"
// entry point, the full review list of pending marks (grouped by page, each removable, plus a
// "clear all" and a count summary), and the "Redact..." action that opens `ConfirmRedactDialog`
// before calling into `apply.ts`.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { ToolPanelProps } from "../../chrome/tool-api";
import { useRubricaErrorMessage } from "../../chrome/errors";
import type { RubricaError } from "../../ipc/bindings";
import { Button, IconButton } from "../../tokens/components";
import { markSelectionAsPendingMarks, useHasMarkableSelection } from "./actions";
import { applyPendingMarks } from "./apply";
import { ConfirmRedactDialog } from "./ConfirmRedactDialog";
import { groupMarksForDisplay } from "./grouping";
import { useMarksForDoc, useRedactStore } from "./model";

export function RedactPanel({ docId }: ToolPanelProps) {
  const { t } = useTranslation(["tools-redact", "common"]);
  const marks = useMarksForDoc(docId);
  const removeMark = useRedactStore((state) => state.removeMark);
  const clearMarks = useRedactStore((state) => state.clearMarks);
  const canMarkSelection = useHasMarkableSelection(docId);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RubricaError | null>(null);
  const toMessage = useRubricaErrorMessage();

  const groups = groupMarksForDisplay(marks);

  async function handleMarkSelection(): Promise<void> {
    await markSelectionAsPendingMarks(docId);
  }

  async function handleConfirm(): Promise<void> {
    setBusy(true);
    setError(null);
    const result = await applyPendingMarks(docId, marks);
    if (result.appliedMarkIds.length > 0) {
      useRedactStore.getState().removeMarks(docId, result.appliedMarkIds);
    }
    setBusy(false);
    if (result.error) {
      // Keep the dialog and any remaining (not-yet-applied) marks so the user can see exactly
      // what's left and retry, rather than silently discarding pending work on a failure.
      setError(result.error);
      return;
    }
    setConfirmOpen(false);
  }

  return (
    <div className="flex h-full flex-col bg-background text-text">
      <header className="border-b border-border px-4 py-3">
        <h2 className="font-display text-base font-semibold">{t("tools-redact:tools-redact.panel.title")}</h2>
      </header>

      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
        <Button variant="secondary" size="sm" disabled={!canMarkSelection} onClick={() => void handleMarkSelection()}>
          {t("tools-redact:tools-redact.actions.markSelection")}
        </Button>
        <Button variant="ghost" size="sm" disabled={marks.length === 0 || busy} onClick={() => clearMarks(docId)}>
          {t("tools-redact:tools-redact.actions.clearAll")}
        </Button>
      </div>

      <p className="px-4 pt-3 text-xs text-muted-text">{t("tools-redact:tools-redact.panel.dragHint")}</p>

      {error && (
        <div
          role="alert"
          className="mx-3 mt-3 flex items-center justify-between gap-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
        >
          <span>{toMessage(error).description}</span>
          <IconButton aria-label={t("common:common.actions.close")} size="sm" onClick={() => setError(null)}>
            <X aria-hidden="true" />
          </IconButton>
        </div>
      )}

      {marks.length === 0 ? (
        <p className="px-4 py-6 text-sm text-muted-text">{t("tools-redact:tools-redact.panel.empty")}</p>
      ) : (
        <div className="flex-1 overflow-auto px-4 py-3">
          <p className="pb-2 text-sm text-muted-text">{t("tools-redact:tools-redact.panel.summary", { count: marks.length })}</p>
          <ul className="flex flex-col gap-3">
            {groups.map((group) => (
              <li key={group.page}>
                <h3 className="pb-1 text-xs font-semibold uppercase tracking-wide text-muted-text">
                  {t("tools-redact:tools-redact.panel.pageLabel", { page: group.page + 1 })}
                </h3>
                <ul className="flex flex-col gap-1">
                  {group.marks.map((mark, index) => (
                    <li key={mark.id} className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2 py-1 text-sm">
                      <span>{t("tools-redact:tools-redact.panel.markLabel", { index: index + 1 })}</span>
                      <IconButton aria-label={t("tools-redact:tools-redact.actions.removeMark")} size="sm" onClick={() => removeMark(docId, mark.id)}>
                        <X aria-hidden="true" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-border px-4 py-3">
        <Button variant="danger" className="w-full" disabled={marks.length === 0 || busy} onClick={() => setConfirmOpen(true)}>
          {t("tools-redact:tools-redact.actions.redact")}
        </Button>
      </div>

      <ConfirmRedactDialog
        open={confirmOpen}
        markCount={marks.length}
        busy={busy}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void handleConfirm()}
      />
    </div>
  );
}
