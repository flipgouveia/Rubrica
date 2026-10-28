// Manual-QA harness for the redact tool (mirrors `tools/pages/dev/PagesHarness.tsx` and
// `tools/annotate/dev/AnnotateHarness.tsx`): stands in for the real chrome shell so this tool can
// be driven and visually verified in a browser today, since the real host doesn't mount any tool
// package into `src/App.tsx` yet. Temporarily pointed at from `src/App.tsx` during development,
// then reverted before landing — `App.tsx` belongs to the orchestrator/R3, not this tool. This
// file itself stays in the repo as a reusable dev aid, same as its two siblings.
//
// There is no real text-selection UI to drive here yet (that's the viewer's job, wave 2) — like
// `AnnotateHarness.tsx`'s `FAKE_SELECTION_RECTS`, this stands in with a hardcoded
// `useSelectionStore().setSelection(...)` call over a known char range of the mock's own page
// body text (see `mock/state.ts`'s `buildTextPageBody` / `mock/text.ts`'s 60-chars-per-line
// layout), so "mark selection" has something real to convert.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { makePageViewport, type PageViewport } from "../../../chrome/tool-api";
import { commands, mockTileUrl } from "../../../ipc";
import type { DocInfo } from "../../../ipc/bindings";
import { Button } from "../../../tokens/components";
import { useSelectionStore } from "../../../viewer/selection/selectionStore";
import { RedactOverlay } from "../RedactOverlay";
import { RedactPanel } from "../RedactPanel";

const DOC_PATH = "demo-text.pdf";
const PAGE = 0;
const ZOOM = 1.25;
/** Spans the first ~90 characters of the mock's fake page body — enough to cross two visual rows at the mock's 60-chars-per-line layout (`mock/text.ts`), so "mark selection" produces more than one pending mark. */
const FAKE_SELECTION_RANGE = { start: 0, end: 90 };

export function RedactHarness() {
  const { t } = useTranslation(["tools-redact", "common"]);
  const [docInfo, setDocInfo] = useState<DocInfo | null>(null);

  useEffect(() => {
    void commands.docOpen(DOC_PATH).then((result) => {
      if (result.status === "ok") setDocInfo(result.data);
    });
  }, []);

  function handleSimulateSelection(): void {
    if (!docInfo) return;
    useSelectionStore.getState().setSelection({
      docId: docInfo.docId,
      anchor: { page: PAGE, charIndex: FAKE_SELECTION_RANGE.start },
      focus: { page: PAGE, charIndex: FAKE_SELECTION_RANGE.end },
    });
  }

  const viewport: PageViewport | null = docInfo
    ? makePageViewport(docInfo.docId, PAGE, docInfo.pages[PAGE].width ?? 612, docInfo.pages[PAGE].height ?? 792, ZOOM, 0)
    : null;

  return (
    <main className="flex h-screen bg-background text-text">
      <div className="flex flex-1 flex-col gap-4 overflow-auto p-8">
        <header className="flex flex-col gap-1">
          <h1 className="font-display text-xl font-semibold">{t("tools-redact:tools-redact.harness.title")}</h1>
          <p className="text-sm text-muted-text">{t("tools-redact:tools-redact.harness.subtitle")}</p>
        </header>

        {!docInfo || !viewport ? (
          <p className="text-sm text-muted-text">{t("common:common.status.loading")}</p>
        ) : (
          <>
            <Button variant="secondary" size="sm" className="self-start" onClick={handleSimulateSelection}>
              {t("tools-redact:tools-redact.harness.simulateSelection")}
            </Button>
            <div className="relative border border-border-strong" style={{ width: viewport.widthPt * viewport.zoom, height: viewport.heightPt * viewport.zoom }}>
              <img
                src={mockTileUrl(docInfo.docId, PAGE, ZOOM, 0, 0, docInfo.revision)}
                alt={t("tools-redact:tools-redact.harness.pageAlt", { page: PAGE + 1 })}
                className="absolute left-0 top-0 h-full w-full"
              />
              <RedactOverlay viewport={viewport} isActive />
            </div>
          </>
        )}
      </div>

      {docInfo && (
        <div className="w-80 shrink-0 border-l border-border">
          <RedactPanel docId={docInfo.docId} activeTool="redact" />
        </div>
      )}
    </main>
  );
}
