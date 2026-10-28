// Main toolbar (brief item 2): file ops, zoom, tool slots via TOOL-API, undo/redo, dirty state.
// Renders only while a document is open — HomeScreen has its own minimal header.
//
// The three file affordances are deliberately separate, one icon each, rather than the single
// "File" menu this shipped with: a folder-open icon that only ever OPENS (native browser +
// recents), a save icon that only ever SAVES (Save / Save As), and a printer icon. Burying
// "Save" inside a folder-open icon gave no visible way to save at all, and no way to open a
// second document without going back Home.
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Command, FolderOpen, Home, Moon, Printer, Redo2, Save, Search, Settings, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { commands } from "../ipc";
import type { RecentDoc, RubricaError } from "../ipc/bindings";
import { Button, IconButton, Menu, Tooltip } from "../tokens/components";
import { useActiveTab } from "../viewer/store";
import { useViewerStore } from "../viewer/store";
import { useHistoryState } from "../viewer/useHistoryState";
import { ZOOM_BUCKETS } from "../viewer/types";
import { useZoomShortcuts, zoomIn, zoomOut } from "../viewer/zoom";
import { useNightModeStore } from "../viewer/nightModeStore";
import { useSearchStore } from "../viewer/search/searchStore";
import { useAppViewStore } from "./appViewStore";
import { useCommandPaletteStore } from "./commandPaletteStore";
import { registerShortcut } from "./shortcuts";
import { useToolbarTools, useActiveToolId, toggleTool } from "./tool-api";
import { SaveAsDialog } from "./SaveAsDialog";
import { PrintDialog } from "./print/PrintDialog";
import { basename, openDocumentByPath } from "./openDocument";
import { browseForPdfToOpen, canBrowseFiles } from "./filePicker";
import { ErrorDialog } from "./errors";

/** Recents shown inline in the Open menu before it gets unwieldy — the Home screen lists them all. */
const RECENTS_IN_MENU = 8;

export function Toolbar() {
  const { t } = useTranslation(["chrome", "common"]);
  const tab = useActiveTab();
  const setZoom = useViewerStore((s) => s.setZoom);
  const history = useHistoryState(tab?.docId ?? null);
  const nightEnabled = useNightModeStore((s) => s.enabled);
  const toggleNightMode = useNightModeStore((s) => s.toggle);
  const navigate = useAppViewStore((s) => s.navigate);
  const openPalette = useCommandPaletteStore((s) => s.open);
  const toolbarTools = useToolbarTools();
  const activeToolId = useActiveToolId();
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [printOpen, setPrintOpen] = useState(false);
  const [recents, setRecents] = useState<RecentDoc[]>([]);
  const [openError, setOpenError] = useState<RubricaError | null>(null);
  const isSearchOpen = useSearchStore((s) => s.isOpen);

  const docId = tab?.docId ?? null;
  useZoomShortcuts(docId);

  // Refreshed when the Open menu is opened rather than on mount, so the list reflects documents
  // opened since this toolbar mounted (including ones opened from this very menu).
  const refreshRecents = useCallback(() => {
    void commands.recentsList().then((result) => {
      if (result.status === "ok") setRecents(result.data);
    });
  }, []);

  const openPath = useCallback(
    async (path: string) => {
      const result = await openDocumentByPath(path);
      if (result.ok) refreshRecents();
      else setOpenError(result.error);
    },
    [refreshRecents],
  );

  const browseAndOpen = useCallback(async () => {
    const picked = await browseForPdfToOpen(t("chrome:chrome.toolbar.openFile"));
    if (picked) await openPath(picked);
  }, [openPath, t]);

  useEffect(() => {
    if (!docId) return undefined;
    const unregisters = [
      registerShortcut({ id: "chrome.doc.save", keys: "ctrl+s", labelKey: "chrome:chrome.shortcuts.save", handler: () => void commands.docSave(docId) }),
      registerShortcut({ id: "chrome.doc.undo", keys: "ctrl+z", labelKey: "chrome:chrome.shortcuts.undo", handler: () => void commands.historyUndo(docId) }),
      registerShortcut({ id: "chrome.doc.redo", keys: "ctrl+y", labelKey: "chrome:chrome.shortcuts.redo", handler: () => void commands.historyRedo(docId) }),
      registerShortcut({ id: "chrome.doc.print", keys: "ctrl+p", labelKey: "chrome:chrome.shortcuts.print", handler: () => setPrintOpen(true) }),
    ];
    return () => unregisters.forEach((unregister) => unregister());
  }, [docId]);

  if (!tab) return null;

  return (
    <div className="flex h-12 items-center gap-1 border-b border-border bg-surface px-2">
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <IconButton aria-label={t("chrome:chrome.toolbar.home")} onClick={() => navigate("home")}>
            <Home className="h-[1.125rem] w-[1.125rem]" />
          </IconButton>
        </Tooltip.Trigger>
        <Tooltip.Content>{t("chrome:chrome.toolbar.home")}</Tooltip.Content>
      </Tooltip.Root>

      <Menu.Root onOpenChange={(open) => open && refreshRecents()}>
        <Menu.Trigger asChild>
          <IconButton aria-label={t("chrome:chrome.toolbar.openMenu")}>
            <FolderOpen className="h-[1.125rem] w-[1.125rem]" />
          </IconButton>
        </Menu.Trigger>
        <Menu.Content align="start">
          {/* No native dialog outside Tauri (mock/browser dev) — the Home screen's typed-path
              field is the only way to open a document there, so don't offer a dead menu item. */}
          {canBrowseFiles && (
            <>
              <Menu.Item onSelect={() => void browseAndOpen()}>{t("chrome:chrome.toolbar.openFile")}</Menu.Item>
              <Menu.Separator />
            </>
          )}
          <Menu.Label>{t("chrome:chrome.toolbar.recentDocuments")}</Menu.Label>
          {recents.length === 0 ? (
            <Menu.Item disabled>{t("chrome:chrome.toolbar.noRecentDocuments")}</Menu.Item>
          ) : (
            recents.slice(0, RECENTS_IN_MENU).map((recent) => (
              <Menu.Item key={recent.path} onSelect={() => void openPath(recent.path)}>
                <span className="max-w-64 truncate" title={recent.path}>
                  {basename(recent.path)}
                </span>
              </Menu.Item>
            ))
          )}
        </Menu.Content>
      </Menu.Root>

      <Menu.Root>
        <Menu.Trigger asChild>
          <IconButton aria-label={t("chrome:chrome.toolbar.saveMenu")}>
            <Save className="h-[1.125rem] w-[1.125rem]" />
          </IconButton>
        </Menu.Trigger>
        <Menu.Content align="start">
          <Menu.Item onSelect={() => void commands.docSave(tab.docId)}>{t("common:common.actions.save")}</Menu.Item>
          <Menu.Item onSelect={() => setSaveAsOpen(true)}>{t("chrome:chrome.toolbar.saveAs")}</Menu.Item>
        </Menu.Content>
      </Menu.Root>

      <IconButton aria-label={t("chrome:chrome.toolbar.print")} onClick={() => setPrintOpen(true)}>
        <Printer className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>

      <div className="mx-1 h-6 w-px bg-border" role="separator" aria-orientation="vertical" />

      <IconButton aria-label={t("common:common.actions.undo")} disabled={!history.canUndo} onClick={() => void commands.historyUndo(tab.docId)}>
        <Undo2 className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>
      <IconButton aria-label={t("common:common.actions.redo")} disabled={!history.canRedo} onClick={() => void commands.historyRedo(tab.docId)}>
        <Redo2 className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>

      <div className="mx-1 h-6 w-px bg-border" role="separator" aria-orientation="vertical" />

      <IconButton aria-label={t("chrome:chrome.toolbar.zoomOut")} onClick={() => zoomOut(tab.docId)}>
        <ZoomOut className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button variant="secondary" size="sm" className="min-w-20 justify-between">
            {Math.round(tab.zoom * 100)}%
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        </Menu.Trigger>
        <Menu.Content>
          <Menu.Item onSelect={() => setZoom(tab.docId, tab.zoom, "fit-width")}>{t("chrome:chrome.toolbar.zoom.fitWidth")}</Menu.Item>
          <Menu.Item onSelect={() => setZoom(tab.docId, tab.zoom, "fit-page")}>{t("chrome:chrome.toolbar.zoom.fitPage")}</Menu.Item>
          <Menu.Separator />
          {ZOOM_BUCKETS.map((bucket) => (
            <Menu.Item key={bucket} onSelect={() => setZoom(tab.docId, bucket, "custom")}>
              {Math.round(bucket * 100)}%
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Root>
      <IconButton aria-label={t("chrome:chrome.toolbar.zoomIn")} onClick={() => zoomIn(tab.docId)}>
        <ZoomIn className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>

      <div className="mx-1 h-6 w-px bg-border" role="separator" aria-orientation="vertical" />

      <IconButton
        aria-label={t("chrome:chrome.toolbar.search")}
        aria-pressed={isSearchOpen}
        onClick={() => useSearchStore.getState().open(tab.docId)}
      >
        <Search className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>
      <IconButton aria-label={t("chrome:chrome.toolbar.nightMode")} aria-pressed={nightEnabled} onClick={toggleNightMode}>
        <Moon className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>

      {toolbarTools.length > 0 && <div className="mx-1 h-6 w-px bg-border" role="separator" aria-orientation="vertical" />}
      {toolbarTools.map((tool) => {
        const Icon = tool.icon;
        return (
          <IconButton
            key={tool.id}
            aria-label={t(tool.labelKey)}
            aria-pressed={activeToolId === tool.id}
            onClick={() => toggleTool(tool.id)}
          >
            <Icon className="h-[1.125rem] w-[1.125rem]" />
          </IconButton>
        );
      })}

      <div className="flex-1" />

      <IconButton aria-label={t("chrome:chrome.toolbar.commandPalette")} onClick={openPalette}>
        <Command className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>
      <IconButton aria-label={t("chrome:chrome.toolbar.settings")} onClick={() => navigate("settings")}>
        <Settings className="h-[1.125rem] w-[1.125rem]" />
      </IconButton>

      <SaveAsDialog docId={tab.docId} currentPath={tab.info.path} open={saveAsOpen} onOpenChange={setSaveAsOpen} />
      <ErrorDialog error={openError} onClose={() => setOpenError(null)} />
      <PrintDialog
        docId={tab.docId}
        pageCount={tab.info.pageCount}
        currentPage={tab.currentPage}
        revision={tab.info.revision}
        open={printOpen}
        onOpenChange={setPrintOpen}
      />
    </div>
  );
}
