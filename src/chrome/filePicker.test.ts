import { beforeEach, describe, expect, it, vi } from "vitest";

// `canBrowseFiles` is decided once at module load (like `isMockEngine` in src/ipc/index.ts), so
// every case re-imports the module under a different environment via `load()` below. `vi.hoisted`
// because both `vi.mock` factories are hoisted above the imports and would otherwise hit the TDZ.
const env = vi.hoisted(() => ({
  inTauri: true,
  pluginLoads: 0,
  openCalls: [] as unknown[],
  saveCalls: [] as unknown[],
  openResult: null as unknown,
  saveResult: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => env.inTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => {
  env.pluginLoads += 1;
  return {
    open: (options: unknown) => {
      env.openCalls.push(options);
      return Promise.resolve(env.openResult);
    },
    save: (options: unknown) => {
      env.saveCalls.push(options);
      return Promise.resolve(env.saveResult);
    },
  };
});

const PDF_FILTER = [{ name: "PDF", extensions: ["pdf"] }];

async function load() {
  vi.resetModules();
  return await import("./filePicker");
}

beforeEach(() => {
  env.inTauri = true;
  env.pluginLoads = 0;
  env.openCalls = [];
  env.saveCalls = [];
  env.openResult = null;
  env.saveResult = null;
});

describe("native file pickers", () => {
  it("resolves to null outside Tauri without ever loading the plugin", async () => {
    env.inTauri = false;
    const picker = await load();

    expect(picker.canBrowseFiles).toBe(false);
    expect(await picker.browseForPdfToOpen("Open file")).toBeNull();
    expect(await picker.browseForSaveTarget("Save As", "C:/docs/text.pdf")).toBeNull();
    // The whole point of the dynamic import: a plain browser / vitest run must never pull in a
    // plugin whose commands would reject, and callers fall back to their typed-path field.
    expect(env.pluginLoads).toBe(0);
  });

  it("opens a single-select, PDF-filtered dialog and returns the chosen path", async () => {
    env.openResult = "C:/Users/me/report.pdf";
    const picker = await load();

    expect(picker.canBrowseFiles).toBe(true);
    expect(await picker.browseForPdfToOpen("Open file")).toBe("C:/Users/me/report.pdf");
    expect(env.openCalls).toEqual([
      { title: "Open file", multiple: false, directory: false, filters: PDF_FILTER },
    ]);
  });

  it("treats a cancelled dialog — or an unexpected multi-selection — as no choice", async () => {
    const picker = await load();

    env.openResult = null;
    expect(await picker.browseForPdfToOpen("Open file")).toBeNull();
    // `multiple: false` should make this unreachable; the guard exists so a future `multiple: true`
    // cannot silently hand a caller an array where it expects a path.
    env.openResult = ["C:/a.pdf", "C:/b.pdf"];
    expect(await picker.browseForPdfToOpen("Open file")).toBeNull();
  });

  it("starts the save dialog at the document's current location", async () => {
    env.saveResult = "C:/Users/me/copy.pdf";
    const picker = await load();

    expect(await picker.browseForSaveTarget("Save As", "C:/Users/me/original.pdf")).toBe("C:/Users/me/copy.pdf");
    expect(env.saveCalls).toEqual([
      { title: "Save As", defaultPath: "C:/Users/me/original.pdf", filters: PDF_FILTER },
    ]);
  });
});
