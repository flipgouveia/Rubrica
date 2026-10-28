// Resolved IPC entry point (CONTRACTS §5). The rest of the app imports
// `commands`/`events` (and `mockTileUrl`/`mockThumbUrl`) from HERE, never
// from `./bindings` or `./mock` directly — this is the one place that
// decides which backend is live.
//
// Detecting "inside Tauri": CONTRACTS suggests checking
// `window.__TAURI_INTERNALS__` directly, but @tauri-apps/api now ships a
// public `isTauri()` helper for exactly this (see
// node_modules/@tauri-apps/api/core.js — it checks the `globalThis.isTauri`
// flag Tauri's init script sets, which `__TAURI_INTERNALS__` itself doesn't
// guarantee across versions). Using the documented API is more future-proof
// than poking at the internals marker by hand, so that's what's used here.
//
// Active when `VITE_MOCK_ENGINE === '1'` OR when not running inside Tauri —
// so `pnpm dev` in a plain browser always works (CONTRACTS §5, verbatim).
import { isTauri } from "@tauri-apps/api/core";
import { commands as realCommands, events as realEvents } from "./bindings";

const useMock = import.meta.env.VITE_MOCK_ENGINE === "1" || !isTauri();

type MockModule = typeof import("./mock");

// R8 "mock hygiene": `useMock` can only ever be decided at runtime (`isTauri()` isn't
// known until the app is actually running), so this can't be a plain static import —
// that would bundle the ~1300-line mock engine (two/three fake documents, canvas-drawn
// placeholder tiles) into the shipped production app even though a real Tauri build
// never uses it. A dynamic `import()`, gated on `useMock`, lets Rollup put `./mock` in
// its own chunk instead of the main one; in a real build `useMock` is always false, so
// this line never even executes and that chunk is never fetched. The top-level `await`
// means every module that (transitively) imports from here — per this file's own
// header comment, that's the whole app — waits for this to settle before its own
// top-level code runs, so `commands`/`events`/`mockTileUrl` below are always the real,
// populated values by the time anything calls them, never a promise or `undefined`.
// (Needs `vite.config.ts`'s `build.target` to support top-level await — see its comment.)
const mock: MockModule | null = useMock ? await import("./mock") : null;

/** Every real call site checks `isMockEngine` before calling one of the four URL helpers below (see PagesPanel.tsx's `thumbSrc`, viewer/Tile.tsx, chrome/Thumbnail.tsx, chrome/print/printWindow.ts) — this stub only exists so those exports keep their real, non-optional function type without the mock module having to be a static import. Firing it at all means one of those call sites has a real bug. */
function unreachableInProduction<F extends (...args: never[]) => unknown>(name: string): F {
  return (() => {
    throw new Error(`${name} called with the mock engine inactive — every call site must check isMockEngine first`);
  }) as unknown as F;
}

export const commands = useMock ? mock!.commands : realCommands;
export const events = useMock ? mock!.events : realEvents;

/**
 * Placeholder tile/thumbnail URLs for the mock engine (see
 * `src/ipc/mock/render.ts`). Only meaningful when `isMockEngine` is true; wave-1
 * viewer code should branch on the same detection (or just always call
 * these when it already knows it's rendering against the mock) rather than
 * constructing a real `rubrica-tile://...` URL in that case.
 */
export const mockTileUrl = mock?.mockTileUrl ?? unreachableInProduction<MockModule["mockTileUrl"]>("mockTileUrl");
export const mockThumbUrl = mock?.mockThumbUrl ?? unreachableInProduction<MockModule["mockThumbUrl"]>("mockThumbUrl");
export const mockTileUrlAsync = mock?.mockTileUrlAsync ?? unreachableInProduction<MockModule["mockTileUrlAsync"]>("mockTileUrlAsync");
export const mockThumbUrlAsync = mock?.mockThumbUrlAsync ?? unreachableInProduction<MockModule["mockThumbUrlAsync"]>("mockThumbUrlAsync");

export const isMockEngine = useMock;

/**
 * Real-engine tile/thumbnail URLs — the platform-correct counterparts of the mock helpers above.
 * See ./protocolUrl.ts for why these can never be a hand-spelled `rubrica-tile://...` string.
 */
export { realThumbUrl, realTileUrl } from "./protocolUrl";
