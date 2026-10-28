// Tool registration API (CONTRACTS §7 keyboard requirement + R3's own brief item: "publish
// src/chrome/TOOL-API.md ... in your first work session"). See TOOL-API.md for the narrative
// version of everything exported here — that file documents this one, not the other way round.
import type { ComponentType } from "react";
import { useMemo } from "react";
import { create } from "zustand";
import type { commands as ipcCommands, events as ipcEvents } from "../ipc";
import { registerShortcut, unregisterShortcut } from "./shortcuts";
import type { DocId } from "../viewer/types";

export type ToolGroup = "annotate" | "pages" | "forms" | "textedit" | "redact";

export interface PageViewport {
  docId: DocId;
  page: number;
  widthPt: number;
  heightPt: number;
  zoom: number;
  rotation: number;
  toScreen(ptX: number, ptY: number): { x: number; y: number };
  toDoc(pxX: number, pxY: number): { x: number; y: number };
}

/** Builds a `PageViewport` for the given page. The one place the point<->pixel flip lives. */
export function makePageViewport(docId: DocId, page: number, widthPt: number, heightPt: number, zoom: number, rotation: number): PageViewport {
  return {
    docId,
    page,
    widthPt,
    heightPt,
    zoom,
    rotation,
    toScreen: (ptX, ptY) => ({ x: ptX * zoom, y: (heightPt - ptY) * zoom }),
    toDoc: (pxX, pxY) => ({ x: pxX / zoom, y: heightPt - pxY / zoom }),
  };
}

export interface ToolPanelProps {
  docId: DocId;
  activeTool: string;
}

export interface ToolOverlayProps {
  viewport: PageViewport;
  isActive: boolean;
}

export interface RailExtensionProps {
  docId: DocId;
  page: number;
  index: number;
  selected: boolean;
  toggleSelected: () => void;
}

export interface PaletteCommandContext {
  docId: DocId | null;
  commands: typeof ipcCommands;
  events: typeof ipcEvents;
}

export interface PaletteCommand {
  id: string;
  labelKey: string;
  run: () => void | Promise<void>;
  shortcutId?: string;
}

export interface ToolShortcutDef {
  id: string;
  keys: string;
  labelKey: string;
  when?: "always" | "tool-active";
  allowInFormFields?: boolean;
  handler: () => void;
}

export interface ToolDefinition {
  id: string;
  group: ToolGroup;
  icon: ComponentType<{ className?: string }>;
  labelKey: string;
  toolbarEntry?: { order: number };
  panel?: ComponentType<ToolPanelProps>;
  overlayLayer?: ComponentType<ToolOverlayProps>;
  overlayAlwaysOn?: boolean;
  railExtension?: ComponentType<RailExtensionProps>;
  shortcuts?: ToolShortcutDef[];
  paletteCommands?: (ctx: PaletteCommandContext) => PaletteCommand[];
}

interface ToolRegistryState {
  tools: Record<string, ToolDefinition>;
  activeTool: string | null;
}

const registeredShortcutIds = new Map<string, string[]>();

const useToolRegistryStore = create<ToolRegistryState>(() => ({ tools: {}, activeTool: null }));

/** Registers a tool package; returns an unregister function (idempotent by `id`, HMR-friendly). */
export function registerTool(def: ToolDefinition): () => void {
  useToolRegistryStore.setState((state) => ({ tools: { ...state.tools, [def.id]: def } }));

  const shortcutIds: string[] = [];
  for (const shortcut of def.shortcuts ?? []) {
    const scope = shortcut.when ?? "tool-active";
    const handler =
      scope === "tool-active"
        ? () => {
            if (useToolRegistryStore.getState().activeTool === def.id) shortcut.handler();
          }
        : shortcut.handler;
    registerShortcut({
      id: shortcut.id,
      keys: shortcut.keys,
      labelKey: shortcut.labelKey,
      handler,
      scope,
      allowInFormFields: shortcut.allowInFormFields,
      toolId: def.id,
    });
    shortcutIds.push(shortcut.id);
  }
  registeredShortcutIds.set(def.id, shortcutIds);

  return () => {
    useToolRegistryStore.setState((state) => {
      const next = { ...state.tools };
      delete next[def.id];
      return { tools: next, activeTool: state.activeTool === def.id ? null : state.activeTool };
    });
    for (const id of registeredShortcutIds.get(def.id) ?? []) unregisterShortcut(id);
    registeredShortcutIds.delete(def.id);
  };
}

export function setActiveTool(id: string | null): void {
  useToolRegistryStore.setState({ activeTool: id });
}

export function toggleTool(id: string): void {
  useToolRegistryStore.setState((state) => ({ activeTool: state.activeTool === id ? null : id }));
}

export function useActiveTool(): ToolDefinition | null {
  const activeId = useToolRegistryStore((state) => state.activeTool);
  const tools = useToolRegistryStore((state) => state.tools);
  return activeId ? (tools[activeId] ?? null) : null;
}

export function useActiveToolId(): string | null {
  return useToolRegistryStore((state) => state.activeTool);
}

export function useRegisteredTools(): ToolDefinition[] {
  const tools = useToolRegistryStore((state) => state.tools);
  return useMemo(() => Object.values(tools), [tools]);
}

/** Tools with a `toolbarEntry`, sorted left-to-right by `order`. */
export function useToolbarTools(): ToolDefinition[] {
  const tools = useRegisteredTools();
  return useMemo(
    () =>
      tools
        .filter((tool): tool is ToolDefinition & { toolbarEntry: { order: number } } => Boolean(tool.toolbarEntry))
        .sort((a, b) => a.toolbarEntry.order - b.toolbarEntry.order),
    [tools],
  );
}

/** The active tool's panel component, or null if the active tool has none (or none is active). */
export function useActiveToolPanel(): { tool: ToolDefinition; Panel: ComponentType<ToolPanelProps> } | null {
  const tool = useActiveTool();
  if (!tool?.panel) return null;
  return { tool, Panel: tool.panel };
}

export interface OverlayEntry {
  tool: ToolDefinition;
  isActive: boolean;
}

/** Every tool whose overlay should render right now: the active tool, plus any `overlayAlwaysOn` tool. */
export function useOverlayTools(): OverlayEntry[] {
  const tools = useRegisteredTools();
  const activeId = useActiveToolId();
  return useMemo(
    () =>
      tools
        .filter((tool) => Boolean(tool.overlayLayer) && (tool.id === activeId || tool.overlayAlwaysOn))
        .map((tool) => ({ tool, isActive: tool.id === activeId })),
    [tools, activeId],
  );
}

/** The active tool's rail extension component, if it registered one. */
export function useActiveRailExtension(): ComponentType<RailExtensionProps> | null {
  const tool = useActiveTool();
  return tool?.railExtension ?? null;
}

export function usePaletteCommands(ctx: PaletteCommandContext): PaletteCommand[] {
  const tools = useRegisteredTools();
  return useMemo(() => tools.flatMap((tool) => tool.paletteCommands?.(ctx) ?? []), [tools, ctx]);
}
