// Recovery dialog (brief item 3: "recovery dialog on recovery_available"). CONTRACTS §4 fires
// this event at startup when an autosave journal exists; §3's `journal_recover` is a query, not
// an apply step — per ARCHITECTURE.md ("autosave journal ... replays committed commands over the
// last saved copy"), replay happens as part of the engine's own `doc_open`, so "Open" here is a
// plain `doc_open(path)` and the recovered state comes back already applied. There is no
// contract command to explicitly discard a journal, so "Not now" just dismisses — the journal
// stays on disk until the next clean save, matching CONTRACTS §8.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "../tokens/components";
import { commands, events } from "../ipc";
import type { RecoveryAvailable, RubricaError } from "../ipc/bindings";
import { openDocumentByPath } from "../chrome/openDocument";
import { ErrorDialog } from "../chrome/errors";

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function RecoveryDialog() {
  const { t, i18n } = useTranslation(["screens", "common"]);
  const [pending, setPending] = useState<RecoveryAvailable | null>(null);
  const [error, setError] = useState<RubricaError | null>(null);

  useEffect(() => {
    const unlistenPromise = events.recoveryAvailable.listen((event) => setPending(event.payload));
    // The backend's own `recovery_available` emit happens inside Tauri's `setup()` hook — before
    // the WebView2 JS runtime has loaded index.html, let alone mounted this component and run this
    // effect. That emit is fire-and-forget (no listener-arrives-later replay), so it is always lost
    // on a real launch, not just occasionally: confirmed by hand, both under the e2e harness and a
    // fully manual `rubrica.exe` launch, that the dialog never appeared despite a valid on-disk
    // journal. `journal_recover(null)` (CONTRACTS §3) runs the identical orphan scan on demand and
    // has no such race, since it's only ever called after this component is already mounted.
    void commands.journalRecover(null).then((result) => {
      if (result.status === "ok" && result.data.available && result.data.path && result.data.journalId && result.data.savedAt) {
        setPending({ path: result.data.path, journalId: result.data.journalId, savedAt: result.data.savedAt });
      }
    });
    return () => {
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  if (!pending) return <ErrorDialog error={error} onClose={() => setError(null)} />;

  const savedAt = new Date(pending.savedAt);
  const savedAtLabel = Number.isNaN(savedAt.getTime()) ? pending.savedAt : new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium", timeStyle: "short" }).format(savedAt);

  return (
    <>
      <Dialog.Root open onOpenChange={(open) => !open && setPending(null)}>
        <Dialog.Content>
          <Dialog.Title>{t("screens:screens.recovery.title")}</Dialog.Title>
          <Dialog.Description>
            {t("screens:screens.recovery.description", { name: basename(pending.path), savedAt: savedAtLabel })}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPending(null)}>
              {t("screens:screens.recovery.notNow")}
            </Button>
            <Button
              onClick={async () => {
                const path = pending.path;
                setPending(null);
                const result = await openDocumentByPath(path);
                if (!result.ok) setError(result.error);
              }}
            >
              {t("screens:screens.recovery.open")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Root>
      <ErrorDialog error={error} onClose={() => setError(null)} />
    </>
  );
}
