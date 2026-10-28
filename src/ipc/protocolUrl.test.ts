import { describe, expect, it, vi } from "vitest";

// Emulates what Tauri's injected `window.__TAURI_INTERNALS__.convertFileSrc` does (tauri crate,
// scripts/core.js — the real one is a one-liner switching on the OS name), so these assertions
// pin the exact URL shape `src-tauri/src/protocols.rs` parses. `vi.hoisted` because `vi.mock`'s
// factory is hoisted above every import in this file and would otherwise hit the TDZ.
const platform = vi.hoisted(() => ({ os: "windows" as "windows" | "macos" }));
vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (filePath: string, protocol = "asset") => {
    const path = encodeURIComponent(filePath);
    return platform.os === "windows" ? `http://${protocol}.localhost/${path}` : `${protocol}://localhost/${path}`;
  },
  isTauri: () => true,
}));

import { realPrintUrl, realThumbUrl, realTileUrl, renderProtocolBase } from "./protocolUrl";

describe("render protocol URLs (the form the webview actually routes, not the CONTRACTS spelling)", () => {
  it("on Windows, never emits the literal scheme as the URL's own protocol", () => {
    platform.os = "windows";
    expect(realTileUrl("doc-3", 0, 1.25, 2, 1, 7)).toBe("http://rubrica-tile.localhost/doc-3/0/1.25/2/1?rev=7");
    expect(realThumbUrl("doc-3", 2, 7)).toBe("http://rubrica-thumb.localhost/doc-3/2?rev=7");
    expect(realTileUrl("doc-3", 0, 1, 0, 0, 0).startsWith("rubrica-tile://")).toBe(false);
  });

  it("builds the print-page URL the rubrica-print handler parses (docId/page/dpi)", () => {
    platform.os = "windows";
    expect(realPrintUrl("doc-3", 0, 150)).toBe("http://rubrica-print.localhost/doc-3/0/150");
    platform.os = "macos";
    expect(realPrintUrl("doc-3", 4, 150)).toBe("rubrica-print://localhost/doc-3/4/150");
  });

  it("keeps every path segment and the ?rev= query un-encoded, exactly as protocols.rs splits them", () => {
    platform.os = "windows";
    const url = new URL(realTileUrl("doc-12", 4, 0.75, 3, 5, 9));
    expect(url.hostname).toBe("rubrica-tile.localhost");
    expect(url.pathname.split("/").slice(1)).toEqual(["doc-12", "4", "0.75", "3", "5"]);
    expect(url.searchParams.get("rev")).toBe("9");
    expect(url.href).not.toMatch(/%2F|%3F|%3D/i);
  });

  it("follows Tauri's platform table instead of hardcoding one (non-Windows form)", () => {
    platform.os = "macos";
    expect(renderProtocolBase("rubrica-thumb")).toBe("rubrica-thumb://localhost/");
    expect(realTileUrl("doc-1", 0, 1, 0, 0, 1)).toBe("rubrica-tile://localhost/doc-1/0/1/0/0?rev=1");
  });
});
