// Left side panel of a tab: "Miniaturas" (the unchanged ThumbnailRail) and "Índice" (the outline
// tree) behind an accessible tablist. Both panels stay mounted and the inactive one is just
// `hidden`, so the rail keeps its scroll position and any tool's page selection while the outline
// is showing. The selected tab is one app-wide choice remembered in `ui.sidePanelTab`.
// The panel is as wide as the rail (w-36) on Miniaturas and wider on Índice, where titles need room.
import { useEffect, useId } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { clsx } from "clsx";
import type { PageSize } from "../ipc/bindings";
import { OutlinePanel } from "../viewer/outline/OutlinePanel";
import { type SidePanelTab, useSidePanelTabStore } from "../viewer/outline/sidePanelTabStore";
import type { DocId } from "../viewer/types";
import { ThumbnailRail } from "./ThumbnailRail";

interface SidePanelProps {
  docId: DocId;
  pageCount: number;
  currentPage: number;
  revision: number;
  pages: PageSize[];
}

const TABS: readonly SidePanelTab[] = ["thumbnails", "outline"];

export function SidePanel({ docId, pageCount, currentPage, revision, pages }: SidePanelProps) {
  const { t } = useTranslation("viewer");
  const tab = useSidePanelTabStore((s) => s.tab);
  const setTab = useSidePanelTabStore((s) => s.setTab);
  const baseId = useId();

  useEffect(() => {
    void useSidePanelTabStore.getState().load();
  }, []);

  const tabId = (name: SidePanelTab) => `${baseId}-tab-${name}`;
  const panelId = (name: SidePanelTab) => `${baseId}-panel-${name}`;
  const labels: Record<SidePanelTab, string> = {
    thumbnails: t("viewer.outline.tabThumbnails"),
    outline: t("viewer.outline.tabOutline"),
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next: SidePanelTab | null = null;
    if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length];
    else if (event.key === "ArrowLeft") next = TABS[(index + TABS.length - 1) % TABS.length];
    else if (event.key === "Home") next = TABS[0];
    else if (event.key === "End") next = TABS[TABS.length - 1];
    if (!next) return;
    event.preventDefault();
    setTab(next);
    document.getElementById(tabId(next))?.focus();
  };

  return (
    <div className={clsx("flex h-full shrink-0 flex-col bg-surface", tab === "outline" ? "w-60" : "w-36")}>
      <div
        role="tablist"
        aria-label={t("viewer.outline.tabsLabel")}
        className="flex gap-0.5 border-b border-r border-border p-1"
        onKeyDown={onKeyDown}
      >
        {TABS.map((name) => (
          <button
            key={name}
            id={tabId(name)}
            type="button"
            role="tab"
            aria-selected={tab === name}
            aria-controls={panelId(name)}
            tabIndex={tab === name ? 0 : -1}
            className={clsx(
              "min-w-0 flex-1 cursor-pointer truncate rounded-sm px-0.5 py-[5px] text-center text-xs outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
              tab === name ? "bg-background font-semibold text-text" : "text-muted-text hover:text-text",
            )}
            onClick={() => setTab(name)}
          >
            {labels[name]}
          </button>
        ))}
      </div>
      <div id={panelId("thumbnails")} role="tabpanel" aria-labelledby={tabId("thumbnails")} hidden={tab !== "thumbnails"} className="min-h-0 flex-1">
        <ThumbnailRail docId={docId} pageCount={pageCount} currentPage={currentPage} revision={revision} pages={pages} />
      </div>
      <div
        id={panelId("outline")}
        role="tabpanel"
        aria-labelledby={tabId("outline")}
        hidden={tab !== "outline"}
        className="min-h-0 flex-1 overflow-auto border-r border-border"
      >
        <OutlinePanel docId={docId} />
      </div>
    </div>
  );
}
