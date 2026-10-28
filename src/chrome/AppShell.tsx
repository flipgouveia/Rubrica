// Top-level layout. Not a router — three mutually exclusive views (home/viewer/settings, see
// appViewStore.ts) plus a handful of always-mounted overlays (command palette, recovery dialog,
// toasts). The whole tab-viewer area is kept mounted (just `hidden` via CSS) even while Home or
// Settings is showing — not only `hidden` between tabs — so a user bouncing over to Home to open
// another file and back doesn't lose scroll position in the tab they left (zoom/currentPage
// already survive that round trip regardless, since they live in the zustand store rather than
// DOM state; scroll position does not, hence the extra care here). Search + the active tool's
// panel are singletons bound to whichever tab is active, since that state is inherently app-wide.
import { useEffect } from "react";
import { Tooltip } from "../tokens/components";
import { useViewerStore } from "../viewer/store";
import { ViewerSurface } from "../viewer/ViewerSurface";
import { useDocStateSync } from "../viewer/useDocStateSync";
import { useNightModeStore } from "../viewer/nightModeStore";
import { SearchPanel } from "../viewer/search/SearchPanel";
import { useSelectionShortcuts } from "../viewer/selection/useSelectionShortcuts";
import { HomeScreen } from "../screens/HomeScreen";
import { SettingsScreen } from "../screens/SettingsScreen";
import { RecoveryDialog } from "../screens/RecoveryDialog";
import { useAppViewStore } from "./appViewStore";
import { CommandPalette } from "./CommandPalette";
import { usePrefsStore } from "./prefsStore";
import { SidePanel } from "./SidePanel";
import { Toolbar } from "./Toolbar";
import { TabsBar } from "./TabsBar";
import { ToastHost } from "./ToastHost";
import { useGlobalShortcuts } from "./shortcuts";
import { useActiveToolPanel } from "./tool-api";

export function AppShell() {
  useGlobalShortcuts();
  useDocStateSync();
  useSelectionShortcuts();

  const view = useAppViewStore((s) => s.view);
  const tabs = useViewerStore((s) => s.tabs);
  const activeTabId = useViewerStore((s) => s.activeTabId);
  const panel = useActiveToolPanel();

  useEffect(() => {
    void usePrefsStore.getState().load();
    void useNightModeStore.getState().load();
  }, []);

  const showViewer = view === "viewer" && tabs.length > 0;

  return (
    <Tooltip.Provider delayDuration={400}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-text">
        <div hidden={!showViewer} className="flex flex-1 flex-col overflow-hidden">
          <Toolbar />
          <TabsBar />
          <div className="relative flex flex-1 overflow-hidden">
            {tabs.map((tab) => (
              <div key={tab.docId} hidden={tab.docId !== activeTabId} className="flex flex-1 overflow-hidden">
                <SidePanel docId={tab.docId} pageCount={tab.info.pageCount} currentPage={tab.currentPage} revision={tab.info.revision} pages={tab.info.pages} />
                <ViewerSurface tab={tab} />
              </div>
            ))}
            {/* Never over the page (B12): compact = a zero-width slot at the viewer's right edge whose
                floating bar overlays only the grey margin; docked = a resizable column in this flex
                row, so the viewer shrinks and ViewerSurface re-fits the width. Before the tool panel
                on purpose, so both stay left of it. */}
            {activeTabId && <SearchPanel docId={activeTabId} />}
            {panel && activeTabId && (
              <div className="w-72 shrink-0 overflow-auto border-l border-border bg-surface">
                <panel.Panel docId={activeTabId} activeTool={panel.tool.id} />
              </div>
            )}
          </div>
        </div>
        {!showViewer && (view === "settings" ? <SettingsScreen /> : <HomeScreen />)}
        <CommandPalette />
        <RecoveryDialog />
        <ToastHost />
      </div>
    </Tooltip.Provider>
  );
}
