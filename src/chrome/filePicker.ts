// Native OS file pickers (tauri-plugin-dialog), used by every "browse" affordance in the app:
// the Home screen's Open button and the Save As dialog.
//
// Why a plugin at all: the webview cannot reach the real filesystem. An `<input type="file">`
// hands back a sandboxed `File` whose `name` is a bare basename, never the absolute path that
// `doc_open(path)` / `doc_save_as(docId, path)` (CONTRACTS §3) require — which is exactly why
// this app shipped with typed-path text fields in place of pickers until now.
//
// Outside Tauri (`pnpm dev` in a plain browser, and every vitest/jsdom run) there is no OS
// dialog to show, so both helpers resolve to `null` and callers fall back to their typed-path
// input. The plugin module is imported dynamically for the same reason `src/ipc/index.ts`
// imports the mock engine dynamically: it never enters the bundle's main chunk, and a
// browser-only run never fetches it at all.
import { isTauri } from "@tauri-apps/api/core";

/** Whether a native file dialog can actually be shown. False in a plain browser and under vitest. */
export const canBrowseFiles = isTauri();

const PDF_FILTER = { name: "PDF", extensions: ["pdf"] };

/**
 * Shows the OS "Open" dialog filtered to PDFs. Resolves to the chosen absolute path, or `null`
 * if the user cancelled (or no native dialog is available).
 */
export async function browseForPdfToOpen(title: string): Promise<string | null> {
  if (!canBrowseFiles) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ title, multiple: false, directory: false, filters: [PDF_FILTER] });
  // `multiple: false` narrows this to `string | null`, but the plugin's signature is the union
  // for all three modes — guard rather than cast, so a future `multiple: true` can't slip through.
  return typeof selected === "string" ? selected : null;
}

/**
 * Shows the OS "Save As" dialog filtered to PDFs, starting at `defaultPath` (the document's
 * current location, so "save a copy next to the original" is one click). Resolves to the chosen
 * absolute path, or `null` if the user cancelled (or no native dialog is available).
 */
export async function browseForSaveTarget(title: string, defaultPath?: string): Promise<string | null> {
  if (!canBrowseFiles) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save({ title, defaultPath, filters: [PDF_FILTER] });
}
