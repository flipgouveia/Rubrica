// Standalone manual-verification harness for the pages tool (R4 brief:
// "build a small standalone harness ... to drive it with the browser
// preview tool"). Not part of the app's real navigation — R3's chrome will
// eventually host `PagesPanel` for real once `src/chrome/TOOL-API.md`
// exists. This file stays in the repo as a reusable dev aid; only
// `App.tsx` was ever temporarily pointed at it, and that was reverted
// before the final commit.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "../../../ipc";
import { PagesPanel } from "../PagesPanel";

const DEMO_DOC_PATH = "demo-text.pdf"; // mock/state.ts: any path containing "text" opens the fake 5-page text doc.

export function PagesHarness() {
  const { t } = useTranslation("common");
  const [docId, setDocId] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void commands.docOpen(DEMO_DOC_PATH).then((result) => {
      if (cancelled) return;
      if (result.status === "ok") setDocId(result.data.docId);
      else setOpenError(result.error.message);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="h-screen bg-background text-text">
      {openError && (
        <p role="alert" className="p-4 text-sm text-danger">
          {`${t("common:common.status.error")}: ${openError}`}
        </p>
      )}
      {!openError && !docId && <p className="p-4 text-sm text-muted-text">{t("common:common.status.loading")}</p>}
      {docId && <PagesPanel docId={docId} />}
    </main>
  );
}
