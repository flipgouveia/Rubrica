// Home screen (brief item 3): recents grid, open-file, drag-drop onto window.
//
// "Open" is now the native OS file dialog (tauri-plugin-dialog, via chrome/filePicker.ts). The
// typed-path field below it is the fallback for where no such dialog exists — mock/browser dev
// and the e2e suite, which cannot drive an OS-owned window. The sample-document shortcuts only
// resolve against the mock engine's fake filesystem, so they are shown only there; in the real
// app they would just raise NOT_FOUND.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FileText, FolderOpen, ScrollText, Settings } from "lucide-react";
import { commands, isMockEngine } from "../ipc";
import type { RecentDoc, RubricaError } from "../ipc/bindings";
import { Button, IconButton } from "../tokens/components";
import { basename, openDocumentByPath } from "../chrome/openDocument";
import { browseForPdfToOpen, canBrowseFiles } from "../chrome/filePicker";
import { ErrorDialog } from "../chrome/errors";
import { useAppViewStore } from "../chrome/appViewStore";

const QUICK_LAUNCH = [
  { path: "demo-text.pdf", icon: FileText, labelKey: "screens:screens.home.quickLaunch.text" },
  { path: "demo-form.pdf", icon: FileText, labelKey: "screens:screens.home.quickLaunch.form" },
  { path: "demo-500-pages.pdf", icon: ScrollText, labelKey: "screens:screens.home.quickLaunch.large" },
] as const;

export function HomeScreen() {
  const { t, i18n } = useTranslation(["screens", "common", "chrome"]);
  const navigate = useAppViewStore((s) => s.navigate);
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState<RubricaError | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const loadRecents = useCallback(() => {
    void commands.recentsList().then((result) => {
      if (result.status === "ok") setRecents(result.data);
    });
  }, []);

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  const handleOpenPath = useCallback(
    async (candidate: string) => {
      if (!candidate.trim()) return;
      const result = await openDocumentByPath(candidate.trim());
      if (!result.ok) setError(result.error);
      else loadRecents();
    },
    [loadRecents],
  );

  const handleBrowse = useCallback(async () => {
    const picked = await browseForPdfToOpen(t("screens:screens.home.browse"));
    if (picked) await handleOpenPath(picked);
  }, [handleOpenPath, t]);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") {
          const [droppedPath] = event.payload.paths;
          if (droppedPath) void handleOpenPath(droppedPath);
        }
        setIsDragging(event.payload.type === "enter" || event.payload.type === "over");
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [handleOpenPath]);

  return (
    <div className="flex h-full flex-col overflow-auto bg-background">
      <header className="flex items-center justify-between border-b border-border px-8 py-5">
        <h1 className="font-display text-2xl font-semibold text-text">{t("common:common.app.name")}</h1>
        <IconButton aria-label={t("chrome:chrome.toolbar.settings")} onClick={() => navigate("settings")}>
          <Settings className="h-5 w-5" />
        </IconButton>
      </header>

      <div
        className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-8 py-10"
        onDragOver={(e) => {
          if (isTauri()) return;
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => !isTauri() && setIsDragging(false)}
        onDrop={(e) => {
          if (isTauri()) return;
          e.preventDefault();
          setIsDragging(false);
          const file = e.dataTransfer.files[0];
          if (file) void handleOpenPath(file.name);
        }}
      >
        <section
          className={`rounded-lg border-2 border-dashed p-6 transition-colors ${isDragging ? "border-accent bg-accent/5" : "border-border-strong"}`}
        >
          <p className="mb-4 text-sm text-muted-text">{t("screens:screens.home.dropHint")}</p>
          {canBrowseFiles && (
            <Button className="h-11 px-5 text-base" onClick={() => void handleBrowse()}>
              <FolderOpen className="h-5 w-5" />
              {t("screens:screens.home.browse")}
            </Button>
          )}
          {isMockEngine && (
            <div className="mt-4 flex flex-wrap gap-2">
              {QUICK_LAUNCH.map(({ path: quickPath, icon: Icon, labelKey }) => (
                <Button key={quickPath} variant="secondary" onClick={() => void handleOpenPath(quickPath)}>
                  <Icon className="h-4 w-4" />
                  {t(labelKey)}
                </Button>
              ))}
            </div>
          )}
          <p className="mt-5 mb-2 text-xs text-muted-text">{t("screens:screens.home.orTypePath")}</p>
          <div className="flex gap-2">
            <input
              type="text"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleOpenPath(path);
              }}
              placeholder={t("screens:screens.home.pathPlaceholder")}
              className="h-10 flex-1 rounded-sm border border-border-strong bg-surface px-3 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
            <Button onClick={() => void handleOpenPath(path)}>
              <FolderOpen className="h-4 w-4" />
              {t("common:common.actions.open")}
            </Button>
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold text-text">{t("screens:screens.home.recentsTitle")}</h2>
            {recents.length > 0 && (
              <button
                type="button"
                className="text-sm text-muted-text hover:text-text"
                onClick={() => void commands.recentsClear().then(loadRecents)}
              >
                {t("screens:screens.home.clearRecents")}
              </button>
            )}
          </div>
          {recents.length === 0 ? (
            <p className="text-sm text-muted-text">{t("screens:screens.home.noRecents")}</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {recents.map((recent) => (
                <li key={recent.path}>
                  <button
                    type="button"
                    onClick={() => void handleOpenPath(recent.path)}
                    className="flex w-full flex-col items-start gap-1 rounded-md border border-border bg-surface p-3 text-left hover:border-border-strong"
                  >
                    <FileText className="h-6 w-6 text-muted-text" />
                    <span className="w-full truncate text-sm font-medium text-text">{basename(recent.path)}</span>
                    <span className="text-xs text-muted-text">
                      {new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(recent.lastOpenedAt))}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <ErrorDialog error={error} onClose={() => setError(null)} />
    </div>
  );
}
