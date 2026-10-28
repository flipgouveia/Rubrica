// Standalone manual-verification harness for the text-edit tool (R6 brief:
// "temporarily point src/App.tsx at a throwaway harness ... to verify
// visually"). Not part of the app's real navigation. Mirrors
// `src/tools/pages/dev/PagesHarness.tsx`'s exact trick: only `App.tsx` was
// ever temporarily pointed at this, and that was reverted before the final
// commit — this file stays in the repo as a reusable dev aid.
//
// Unlike PagesPanel (a standalone prop-driven component from before
// TOOL-API.md existed), this tool is wired through the real `registerTool`
// registry, so this harness renders a tiny stand-in "shell": a page canvas
// hosting the overlay, plus the real panel, wired to the same shared
// zustand stores the real chrome would provide via `PageCanvas`/`AppShell`.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "../../../ipc";
import { makePageViewport } from "../../../chrome/tool-api";
import { Tooltip } from "../../../tokens/components";
import { TextEditOverlay } from "../TextEditOverlay";
import { TextEditPanel } from "../TextEditPanel";
import "../index"; // side-effect: registerTool (unused directly here, but proves the module loads cleanly)

const DEMO_DOC_PATH = "demo-text.pdf"; // mock/state.ts: any path containing "text" opens the fake 5-page text doc.
const ZOOM = 1.25;

export function TextEditHarness() {
  const { t } = useTranslation("common");
  const [docId, setDocId] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState<{ width: number; height: number } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void commands.docOpen(DEMO_DOC_PATH).then((result) => {
      if (cancelled) return;
      if (result.status === "ok") {
        setDocId(result.data.docId);
        setPageSize({ width: result.data.pages[0].width ?? 612, height: result.data.pages[0].height ?? 792 });
      } else {
        setOpenError(result.error.message);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Tooltip.Provider delayDuration={400}>
      <main className="flex h-screen bg-background text-text">
        {openError && (
          <p role="alert" className="p-4 text-sm text-danger">
            {`${t("common:common.status.error")}: ${openError}`}
          </p>
        )}
        {!openError && !docId && <p className="p-4 text-sm text-muted-text">{t("common:common.status.loading")}</p>}
        {docId && pageSize && (
          <>
            <div className="flex flex-1 items-start justify-center overflow-auto bg-surface p-8">
              <div className="relative bg-white shadow-md" style={{ width: pageSize.width * ZOOM, height: pageSize.height * ZOOM }}>
                <TextEditOverlay viewport={makePageViewport(docId, 0, pageSize.width, pageSize.height, ZOOM, 0)} isActive />
              </div>
            </div>
            <div className="w-72 shrink-0 overflow-auto border-l border-border bg-surface">
              <TextEditPanel docId={docId} activeTool="text-edit" />
            </div>
          </>
        )}
      </main>
    </Tooltip.Provider>
  );
}
