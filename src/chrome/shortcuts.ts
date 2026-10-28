// Central keyboard-shortcut registry (CONTRACTS §7: "every tool reachable by keyboard;
// shortcuts registered through one central map"). See TOOL-API.md for the tool-facing surface
// (`ToolDefinition.shortcuts` forwards here via `registerTool` in tool-api.tsx) — this module
// itself knows nothing about tools, only combo strings and handlers, so it has no dependency on
// tool-api.tsx (registerTool depends on this, not the other way round).
import { useEffect, useSyncExternalStore } from "react";

export type ShortcutScope = "always" | "tool-active";

export interface ShortcutEntry {
  id: string;
  keys: string;
  labelKey: string;
  handler: () => void;
  scope: ShortcutScope;
  /** Fires even while focus is inside an input/textarea/contenteditable. Default false. */
  allowInFormFields?: boolean;
  /** Purely informational (grouping in the shortcuts map / command palette), no gating effect. */
  toolId?: string;
}

export type RegisterShortcutInput = Omit<ShortcutEntry, "scope"> & { scope?: ShortcutScope };

const registry = new Map<string, ShortcutEntry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Canonicalizes a combo string: order-independent modifiers, lower-case, "mod" -> "ctrl". */
export function normalizeCombo(keys: string): string {
  const parts = keys
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => (part === "mod" ? "ctrl" : part))
    .map((part) => KEY_ALIASES[part] ?? part);
  const modifiers = ["ctrl", "alt", "shift"].filter((mod) => parts.includes(mod));
  const key = parts.find((part) => !["ctrl", "alt", "shift"].includes(part));
  return [...modifiers, key].filter(Boolean).join("+");
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  del: "delete",
  return: "enter",
  spacebar: " ",
  space: " ",
};

/**
 * "+" and "-" can't be written in a combo string (it is split on "+") and sit on different keys per
 * layout: US has "=" / Shift+"=" for plus, Portuguese has a plain "+" key, and the numpad has its
 * own. Fold them into "plus" / "minus" so one registration covers every variant. `shift` is
 * reported with it because on US it is part of typing "+" (Ctrl+Shift+= is Ctrl+plus) — except for
 * "=", which only counts unshifted (on a Portuguese keyboard Shift+0 types "=").
 */
function plusMinusFromEvent(event: KeyboardEvent): "plus" | "minus" | null {
  if (event.code === "NumpadAdd") return "plus";
  if (event.code === "NumpadSubtract") return "minus";
  if (event.key === "+") return "plus";
  if (event.key === "=" && !event.shiftKey) return "plus";
  if (event.key === "-") return "minus";
  if (event.key === "_" && event.shiftKey) return "minus";
  return null;
}

function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("ctrl");
  if (event.altKey) parts.push("alt");
  const plusMinus = plusMinusFromEvent(event);
  if (event.shiftKey && !plusMinus) parts.push("shift");
  const key = plusMinus ?? event.key.toLowerCase();
  if (!["control", "alt", "shift", "meta"].includes(key)) parts.push(key);
  return parts.join("+");
}

/** Registers a shortcut; returns an unregister function. `scope` defaults to "always". */
export function registerShortcut(input: RegisterShortcutInput): () => void {
  const entry: ShortcutEntry = { scope: "always", ...input, keys: normalizeCombo(input.keys) };
  if (
    entry.scope === "always" &&
    Array.from(registry.values()).some((existing) => existing.scope === "always" && existing.keys === entry.keys && existing.id !== entry.id)
  ) {
    console.error(`[shortcuts] duplicate "always" binding for "${entry.keys}": "${entry.id}" collides with an existing shortcut`);
  }
  registry.set(entry.id, entry);
  cachedList = null;
  notify();
  return () => unregisterShortcut(entry.id);
}

export function unregisterShortcut(id: string): void {
  if (registry.delete(id)) {
    cachedList = null;
    notify();
  }
}

// `useSyncExternalStore` requires `getSnapshot` to return a referentially-stable result when
// nothing changed (React compares via `Object.is` on every render to decide whether to re-render
// — an ever-new array here caused an infinite render loop, surfaced by React's own "getSnapshot
// should be cached" warning). Cache the array and only recompute it when the registry itself
// changes (register/unregister above), never on every read.
let cachedList: ShortcutEntry[] | null = null;

export function listShortcuts(): ShortcutEntry[] {
  cachedList ??= Array.from(registry.values());
  return cachedList;
}

function isFormField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

function handleKeyDown(event: KeyboardEvent): void {
  const combo = comboFromEvent(event);
  if (!combo) return;
  const inFormField = isFormField(event.target);
  const matches = Array.from(registry.values()).filter(
    (entry) => entry.keys === combo && (!inFormField || entry.allowInFormFields),
  );
  if (matches.length === 0) return;
  event.preventDefault();
  for (const entry of matches) entry.handler();
}

/** Mount once at the app root. Attaches a single window-level keydown listener. */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}

/** Reactive list of every registered shortcut, for the Settings shortcuts map / command palette. */
export function useShortcutList(): ShortcutEntry[] {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    listShortcuts,
    listShortcuts,
  );
}

const KEY_DISPLAY_NAMES: Record<string, string> = {
  arrowright: "ArrowRight",
  arrowleft: "ArrowLeft",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  escape: "Escape",
  enter: "Enter",
  delete: "Delete",
  " ": "Space",
};

/** Human-readable rendering of a combo, e.g. "ctrl+shift+h" -> "Ctrl+Shift+H". */
export function formatCombo(keys: string): string {
  return keys
    .split("+")
    .map((part) => KEY_DISPLAY_NAMES[part] ?? (part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1)))
    .join("+");
}
