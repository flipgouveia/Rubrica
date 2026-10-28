// Manual-QA harness for the annotation tool (R4 brief: "chrome mounting is
// a later wiring step, not your job" — this stands in for the real app
// shell so the tool can be driven and visually verified in a browser today).
//
// Temporarily pointed at from `src/App.tsx` during development
// (`import { AnnotateHarness } from "./tools/annotate/dev/AnnotateHarness";
// export default function App() { return <AnnotateHarness />; }`), then
// reverted before landing — `App.tsx` belongs to R3, not this tool.
//
// Opens the mock 5-page text document, renders its first page via the mock
// tile placeholder at a fixed zoom, and mounts `AnnotationToolbar` +
// `AnnotationLayer` on top of it, wiring their shared `{ mode, style,
// selectedId }` state (see those two components' own header comments for
// why that state is lifted here rather than owned by either of them).
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, events, mockTileUrl } from "../../../ipc";
import type { Annot, AnnotSpec, DocInfo } from "../../../ipc/bindings";
import { Button } from "../../../tokens/components";
import { nz } from "../../shared/coords";
import type { PageViewport, ScreenRect } from "../../shared/coords";
import { AnnotationLayer } from "../AnnotationLayer";
import { AnnotationToolbar } from "../AnnotationToolbar";
import { DEFAULT_ANNOTATION_STYLE, isMarkupMode, type AnnotationMode, type AnnotationStyle } from "../model";
import { deriveQuadpointsFromSelectionRects } from "../selection";

const DOC_PATH = "demo-text.pdf";
const PAGE = 0;
const ZOOM = 1.25;
/** A fixed stand-in for "the user selected this line of text" — see `selection.ts`'s header comment for why this is hardcoded rather than driven by a real selection API. Roughly where the mock's own page-heading text run sits (`mock/state.ts`'s `buildTextPageBody`/`textRuns`). */
const FAKE_SELECTION_RECTS: ScreenRect[] = [{ x: 72 * ZOOM, y: 90 * ZOOM, width: 300 * ZOOM, height: 20 * ZOOM }];

interface HistoryStatus {
  canUndo: boolean;
  canRedo: boolean;
  dirty: boolean;
}

export function AnnotateHarness() {
  const { t } = useTranslation("tools-annotate");
  const [docInfo, setDocInfo] = useState<DocInfo | null>(null);
  const [history, setHistory] = useState<HistoryStatus>({ canUndo: false, canRedo: false, dirty: false });
  const [mode, setMode] = useState<AnnotationMode>("select");
  const [style, setStyle] = useState<AnnotationStyle>(DEFAULT_ANNOTATION_STYLE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedAnnot, setSelectedAnnot] = useState<Annot | null>(null);

  const refreshHistory = useCallback(async (docId: string) => {
    const result = await commands.historyState(docId);
    if (result.status === "ok") setHistory(result.data);
  }, []);

  useEffect(() => {
    void commands.docOpen(DOC_PATH).then((result) => {
      if (result.status === "ok") {
        setDocInfo(result.data);
        void refreshHistory(result.data.docId);
      }
    });
  }, [refreshHistory]);

  useEffect(() => {
    const unlistenPromise = events.docStateChanged.listen((event) => {
      const { docId, revision, dirty } = event.payload;
      setDocInfo((prev) => (prev && prev.docId === docId ? { ...prev, revision, dirty } : prev));
      void refreshHistory(docId);
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [refreshHistory]);

  const viewport: PageViewport | null = docInfo
    ? { pageWidthPt: nz(docInfo.pages[PAGE].width), pageHeightPt: nz(docInfo.pages[PAGE].height), scale: ZOOM }
    : null;

  async function handleSimulateSelection() {
    if (!docInfo || !viewport || !isMarkupMode(mode)) return;
    const quadpoints = deriveQuadpointsFromSelectionRects(FAKE_SELECTION_RECTS, viewport);
    const spec = { kind: mode, page: PAGE, quadpoints, color: style.color, opacity: style.opacity } as AnnotSpec;
    await commands.annotAdd(docInfo.docId, spec);
  }

  async function handleDeleteSelected() {
    if (!docInfo || !selectedId) return;
    await commands.annotDelete(docInfo.docId, selectedId);
    setSelectedId(null);
  }

  return (
    <main className="min-h-screen bg-background p-8 text-text">
      <div className="mx-auto flex max-w-4xl flex-col gap-4">
        <header className="flex flex-col gap-1">
          <h1 className="font-display text-xl font-semibold">{t("tools-annotate.harness.title")}</h1>
          <p className="text-sm text-muted-text">{t("tools-annotate.harness.subtitle")}</p>
        </header>

        {!docInfo || !viewport ? (
          <p className="text-sm text-muted-text">{t("tools-annotate.harness.noDocument")}</p>
        ) : (
          <>
            <AnnotationToolbar
              docId={docInfo.docId}
              mode={mode}
              onModeChange={setMode}
              style={style}
              onStyleChange={(patch) => setStyle((s) => ({ ...s, ...patch }))}
              selectedAnnot={selectedAnnot}
              onDeleteSelected={() => void handleDeleteSelected()}
            />

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" disabled={!isMarkupMode(mode)} onClick={() => void handleSimulateSelection()}>
                {t("tools-annotate.harness.simulateSelection")}
              </Button>
              <Button variant="ghost" size="sm" disabled={!history.canUndo} onClick={() => void commands.historyUndo(docInfo.docId)}>
                {t("common:common.actions.undo")}
              </Button>
              <Button variant="ghost" size="sm" disabled={!history.canRedo} onClick={() => void commands.historyRedo(docInfo.docId)}>
                {t("common:common.actions.redo")}
              </Button>
              <span className="text-xs text-muted-text">
                {t("tools-annotate.harness.status", { revision: docInfo.revision, dirty: history.dirty ? t("tools-annotate.harness.dirtyYes") : t("tools-annotate.harness.dirtyNo") })}
              </span>
            </div>

            <div className="relative border border-border-strong" style={{ width: viewport.pageWidthPt * viewport.scale, height: viewport.pageHeightPt * viewport.scale }}>
              <img
                src={mockTileUrl(docInfo.docId, PAGE, ZOOM, 0, 0, docInfo.revision)}
                alt={t("tools-annotate.harness.pageAlt", { page: PAGE + 1 })}
                className="absolute left-0 top-0 h-full w-full"
              />
              <AnnotationLayer
                docId={docInfo.docId}
                page={PAGE}
                viewport={viewport}
                mode={mode}
                style={style}
                selectedId={selectedId}
                onSelectedIdChange={setSelectedId}
                onSelectedAnnotChange={setSelectedAnnot}
              />
            </div>
          </>
        )}
      </div>
    </main>
  );
}
