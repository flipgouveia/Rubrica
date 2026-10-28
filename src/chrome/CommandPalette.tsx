// Command palette (brief item 2). Combines a handful of built-in app commands, every registered
// tool's implicit "activate" entry, and each tool's own `paletteCommands` (TOOL-API.md) into one
// fuzzy-filterable list — R4/R6 tools show up here automatically the moment they call
// `registerTool`, no extra wiring on their side.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { commands, events } from "../ipc";
import { Dialog } from "../tokens/components";
import { useNightModeStore } from "../viewer/nightModeStore";
import { useSearchStore } from "../viewer/search/searchStore";
import { useViewerStore } from "../viewer/store";
import { useAppViewStore } from "./appViewStore";
import { useCommandPaletteStore } from "./commandPaletteStore";
import { registerShortcut } from "./shortcuts";
import { toggleTool, usePaletteCommands, useToolbarTools } from "./tool-api";

interface PaletteEntry {
  id: string;
  label: string;
  run: () => void;
}

export function CommandPalette() {
  const { t } = useTranslation(["chrome", "common"]);
  const isOpen = useCommandPaletteStore((s) => s.isOpen);
  const close = useCommandPaletteStore((s) => s.close);
  const toggle = useCommandPaletteStore((s) => s.toggle);
  const [query, setQuery] = useState("");
  const activeTabId = useViewerStore((s) => s.activeTabId);
  const navigate = useAppViewStore((s) => s.navigate);
  const toolbarTools = useToolbarTools();
  const toolCommands = usePaletteCommands({ docId: activeTabId, commands, events });

  useEffect(() => registerShortcut({ id: "chrome.commandPalette.toggle", keys: "ctrl+k", labelKey: "chrome:chrome.shortcuts.commandPalette", handler: toggle }), [toggle]);
  useEffect(() => {
    if (!isOpen) setQuery("");
  }, [isOpen]);

  const entries = useMemo((): PaletteEntry[] => {
    const builtins: PaletteEntry[] = [
      { id: "nav.home", label: t("chrome:chrome.palette.goHome"), run: () => navigate("home") },
      { id: "nav.settings", label: t("chrome:chrome.palette.openSettings"), run: () => navigate("settings") },
    ];
    if (activeTabId) {
      builtins.push(
        { id: "doc.save", label: t("common:common.actions.save"), run: () => void commands.docSave(activeTabId) },
        { id: "doc.undo", label: t("common:common.actions.undo"), run: () => void commands.historyUndo(activeTabId) },
        { id: "doc.redo", label: t("common:common.actions.redo"), run: () => void commands.historyRedo(activeTabId) },
        { id: "search.open", label: t("chrome:chrome.palette.search"), run: () => useSearchStore.getState().open(activeTabId) },
        { id: "nightMode.toggle", label: t("chrome:chrome.palette.toggleNightMode"), run: () => useNightModeStore.getState().toggle() },
      );
    }
    const toolActivations: PaletteEntry[] = toolbarTools.map((tool) => ({
      id: `tool.activate.${tool.id}`,
      label: t(tool.labelKey),
      run: () => toggleTool(tool.id),
    }));
    const extra: PaletteEntry[] = toolCommands.map((cmd) => ({ id: cmd.id, label: t(cmd.labelKey), run: () => void cmd.run() }));
    return [...builtins, ...toolActivations, ...extra];
  }, [t, navigate, activeTabId, toolbarTools, toolCommands]);

  const filtered = query ? entries.filter((entry) => entry.label.toLowerCase().includes(query.toLowerCase())) : entries;

  return (
    <Dialog.Root open={isOpen} onOpenChange={(open) => !open && close()}>
      <Dialog.Content className="max-w-lg overflow-hidden p-0">
        <Dialog.Title className="sr-only">{t("chrome:chrome.palette.title")}</Dialog.Title>
        <Dialog.Description className="sr-only">{t("chrome:chrome.palette.description")}</Dialog.Description>
        <input
          autoFocus
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("chrome:chrome.palette.placeholder")}
          className="h-11 w-full border-b border-border bg-transparent px-4 text-sm text-text outline-none"
        />
        <ul className="max-h-80 overflow-auto p-1">
          {filtered.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                className="block w-full rounded-sm px-3 py-2 text-left text-sm text-text hover:bg-border/40"
                onClick={() => {
                  entry.run();
                  close();
                }}
              >
                {entry.label}
              </button>
            </li>
          ))}
          {filtered.length === 0 && <li className="px-3 py-2 text-sm text-muted-text">{t("chrome:chrome.palette.noResults")}</li>}
        </ul>
      </Dialog.Content>
    </Dialog.Root>
  );
}
