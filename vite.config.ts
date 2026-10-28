/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Tauri expects a fixed dev server port and to not be cleared by other tooling.
// https://v2.tauri.app/start/frontend/vite/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },

  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Rubrica ships on Windows/WebView2 only (ARCHITECTURE.md) — no macOS/Linux target
    // exists anywhere else in this repo (installer/, tauri.conf.json, CI are all
    // Windows-specific), so the safari13 fallback the stock Tauri+Vite template ships
    // with is dead weight here. Fixed at chrome105 (the WebView2 baseline) rather than
    // branching on `TAURI_ENV_PLATFORM` — this also lets `src/ipc/index.ts` use a
    // top-level `await import(...)` for mock-hygiene (R8), which chrome105 supports and
    // safari13 does not; a plain `pnpm build` (CI's `frontend` job, no Tauri env vars
    // set) needs the same target as `pnpm tauri build` for that to work everywhere.
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
