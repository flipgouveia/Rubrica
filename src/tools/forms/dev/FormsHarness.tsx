// Manual-QA harness for the forms tool (R4 brief: "build a small standalone
// harness ... temporarily point src/App.tsx at this harness ... verify
// visually, then REVERT App.tsx"). Not part of the tool's actual product —
// there is no real chrome/viewer to mount into yet (R3's `TOOL-API.md`
// doesn't exist in this worktree), so this stands in for it: opens the mock
// form document, lays out both its pages as plain placeholder images
// (`mockTileUrl`), and mounts one `FieldOverlay` per page plus one
// `FieldsPanel`, so every field kind can be exercised by mouse AND by
// keyboard alone.
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, events, mockTileUrl } from "../../../ipc";
import type { DocInfo } from "../../../ipc/bindings";
import type { PageViewport } from "../../shared/coords";
import { FieldOverlay } from "../FieldOverlay";
import { FieldsPanel } from "../FieldsPanel";

// "form" in the path matches the mock's `doc_open` convention
// (`src/ipc/mock/state.ts`'s `resolveDocKindFromPath`) and opens the fake
// 2-page form document — NOT "demo-text.pdf", which opens the unrelated
// 5-page plain-text fixture.
const HARNESS_DOC_PATH = "demo-form.pdf";
// CSS pixels per PDF point — arbitrary, just "looks reasonable in a browser
// window" for a 612x792pt (US Letter) page.
const SCALE = 0.85;

export function FormsHarness() {
  const { t } = useTranslation(["tools-forms", "common"]);
  const [docInfo, setDocInfo] = useState<DocInfo | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const docIdRef = useRef<string | null>(null);

  useEffect(() => {
    const unlistenPromise = events.docStateChanged.listen((event) => {
      if (event.payload.docId !== docIdRef.current) return;
      setDocInfo((prev) =>
        prev && prev.docId === event.payload.docId ? { ...prev, revision: event.payload.revision, dirty: event.payload.dirty } : prev,
      );
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  const handleOpen = useCallback(async () => {
    const result = await commands.docOpen(HARNESS_DOC_PATH);
    if (result.status === "error") {
      setStatusMessage(t("tools-forms:tools-forms.harness.openFailed", { message: result.error.message }));
      return;
    }
    docIdRef.current = result.data.docId;
    setDocInfo(result.data);
    setStatusMessage(null);
  }, [t]);

  useEffect(() => {
    void handleOpen();
  }, [handleOpen]);

  return (
    <main className="min-h-screen bg-background p-8 text-text">
      <div className="mx-auto flex max-w-5xl items-start gap-6">
        <div className="flex flex-1 flex-col gap-6">
          <h1 className="font-display text-xl font-semibold">{t("tools-forms:tools-forms.harness.title")}</h1>
          {statusMessage && <p className="text-sm text-danger">{statusMessage}</p>}
          {docInfo?.pages.map((page, index) => {
            const viewport: PageViewport = {
              pageWidthPt: page.width ?? 612,
              pageHeightPt: page.height ?? 792,
              scale: SCALE,
            };
            const width = viewport.pageWidthPt * SCALE;
            const height = viewport.pageHeightPt * SCALE;
            return (
              <div key={index} className="relative border border-border" style={{ width, height }}>
                <img
                  src={mockTileUrl(docInfo.docId, index, 1, 0, 0, docInfo.revision)}
                  alt={t("tools-forms:tools-forms.harness.pageAlt", { page: index + 1 })}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <FieldOverlay docId={docInfo.docId} page={index} viewport={viewport} />
              </div>
            );
          })}
        </div>
        {docInfo && <FieldsPanel docId={docInfo.docId} />}
      </div>
    </main>
  );
}
