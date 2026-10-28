// Tabs for multiple open documents (brief item 2). A filled dot marks a dirty tab; closing a
// dirty tab confirms first (docs are never auto-saved on close — mirrors mock/state.ts's
// documented "close without saving discards edits" behavior on the engine side).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Plus, X } from "lucide-react";
import { commands } from "../ipc";
import { IconButton } from "../tokens/components";
import { clsx } from "clsx";
import { useAppViewStore } from "./appViewStore";
import { ConfirmDialog } from "./ConfirmDialog";
import { useViewerStore } from "../viewer/store";
import type { DocId } from "../viewer/types";

function basename(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function TabsBar() {
  const { t } = useTranslation(["chrome", "common"]);
  const tabs = useViewerStore((s) => s.tabs);
  const activeTabId = useViewerStore((s) => s.activeTabId);
  const view = useAppViewStore((s) => s.view);
  const navigate = useAppViewStore((s) => s.navigate);
  const setActiveTab = useViewerStore((s) => s.setActiveTab);
  const [pendingClose, setPendingClose] = useState<DocId | null>(null);

  if (tabs.length === 0) return null;

  const closeTab = (docId: DocId) => {
    void commands.docClose(docId);
    useViewerStore.getState().closeTab(docId);
    if (useViewerStore.getState().tabs.length === 0) navigate("home");
  };

  const requestClose = (docId: DocId) => {
    const tab = tabs.find((t2) => t2.docId === docId);
    if (tab?.info.dirty) setPendingClose(docId);
    else closeTab(docId);
  };

  return (
    <div className="flex h-10 items-center gap-1 border-b border-border bg-surface px-2" role="tablist">
      {tabs.map((tab) => {
        const isActive = view === "viewer" && tab.docId === activeTabId;
        return (
          <div
            key={tab.docId}
            role="tab"
            aria-selected={isActive}
            className={clsx(
              "group flex h-8 max-w-56 min-w-0 cursor-pointer items-center gap-1.5 rounded-t-md px-2.5 text-sm",
              isActive ? "bg-background text-text" : "text-muted-text hover:bg-border/40",
            )}
            onClick={() => {
              setActiveTab(tab.docId);
              navigate("viewer");
            }}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{basename(tab.info.path) || t("chrome:chrome.tabs.untitled")}</span>
            {tab.info.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />}
            <IconButton
              aria-label={t("chrome:chrome.tabs.close", { name: basename(tab.info.path) })}
              size="sm"
              className="shrink-0 opacity-0 group-hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                requestClose(tab.docId);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </IconButton>
          </div>
        );
      })}
      <IconButton aria-label={t("chrome:chrome.tabs.openNew")} size="sm" onClick={() => navigate("home")}>
        <Plus className="h-4 w-4" />
      </IconButton>

      <ConfirmDialog
        open={pendingClose !== null}
        onOpenChange={(open) => !open && setPendingClose(null)}
        title={t("chrome:chrome.tabs.closeDirtyTitle")}
        description={t("chrome:chrome.tabs.closeDirtyDescription")}
        confirmLabel={t("chrome:chrome.tabs.closeWithoutSaving")}
        tone="danger"
        onConfirm={() => {
          if (pendingClose) closeTab(pendingClose);
        }}
      />
    </div>
  );
}
