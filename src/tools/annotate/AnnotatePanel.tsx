// TOOL-API.md `panel` adapter around `AnnotationToolbar`: threads the lifted `{ mode, style,
// selection }` state (`store.ts`) into the prop-driven component R4 built, exactly the role
// `dev/AnnotateHarness.tsx` played during that wave.
//
// The "apply to selection" button below is this file's own addition, not part of
// `AnnotationToolbar` itself: highlight/underline/strikeout are "created from a text selection,
// not a canvas drag" (AnnotationLayer.tsx's own header comment), but nothing wired the real
// viewer selection (`src/viewer/selection/selectionStore.ts`) to annotation creation until
// `applyMarkupToSelection.ts` — see that file's header comment for the full story. Kept here
// rather than inside `AnnotationToolbar.tsx` so R4's component stays exactly as that wave left it.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ToolPanelProps } from "../../chrome/tool-api";
import { commands } from "../../ipc";
import type { RubricaError } from "../../ipc/bindings";
import { Button } from "../../tokens/components";
import { ErrorDialog } from "../../chrome/errors";
import { applyMarkupToSelection, useCanApplyMarkupToSelection } from "./applyMarkupToSelection";
import { AnnotationToolbar } from "./AnnotationToolbar";
import { isMarkupMode } from "./model";
import { useAnnotateStore } from "./store";
import { useSelectedAnnot } from "./useAnnotations";

export function AnnotatePanel({ docId }: ToolPanelProps) {
  const { t } = useTranslation("tools-annotate");
  const mode = useAnnotateStore((s) => s.mode);
  const setMode = useAnnotateStore((s) => s.setMode);
  const style = useAnnotateStore((s) => s.style);
  const setStyle = useAnnotateStore((s) => s.setStyle);
  const selection = useAnnotateStore((s) => s.selection);
  const setSelection = useAnnotateStore((s) => s.setSelection);
  const selectedAnnot = useSelectedAnnot(docId);
  const canApplyToSelection = useCanApplyMarkupToSelection(docId, mode);
  const [applyError, setApplyError] = useState<RubricaError | null>(null);

  async function handleDeleteSelected() {
    if (!selection) return;
    await commands.annotDelete(selection.docId, selection.id);
    setSelection(null);
  }

  return (
    <div className="flex flex-col gap-3">
      <AnnotationToolbar
        docId={docId}
        mode={mode}
        onModeChange={setMode}
        style={style}
        onStyleChange={setStyle}
        selectedAnnot={selectedAnnot}
        onDeleteSelected={() => void handleDeleteSelected()}
      />
      {isMarkupMode(mode) && (
        <div className="flex flex-col gap-1.5 px-3">
          <Button
            variant="primary"
            size="sm"
            disabled={!canApplyToSelection}
            onClick={() =>
              void applyMarkupToSelection(docId, mode, style).then((result) => {
                if (!result.ok) setApplyError(result.error);
              })
            }
          >
            {t("tools-annotate:tools-annotate.toolbar.applyToSelection")}
          </Button>
          {!canApplyToSelection && <p className="text-xs text-muted-text">{t("tools-annotate:tools-annotate.toolbar.applyToSelectionHint")}</p>}
        </div>
      )}
      <ErrorDialog error={applyError} onClose={() => setApplyError(null)} />
    </div>
  );
}
