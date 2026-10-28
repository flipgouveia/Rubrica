#!/usr/bin/env node
// Orchestrates the whole e2e run: resolve a matching msedgedriver → spawn tauri-driver in front
// of it → run the WebdriverIO suite against the real built app → tear everything down. This is
// what `pnpm e2e` calls; nothing else in this directory should be run standalone (wdio.conf.mjs's
// own header comment explains why).
//
// Prerequisites this script does NOT install for you (see e2e/README.md):
//   - `cargo install tauri-driver --locked` (once per machine/CI cache)
//   - a built app exe (`pnpm tauri build --debug`, or set RUBRICA_E2E_EXE to any built rubrica.exe)
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { download as downloadEdgeDriver } from "edgedriver";
import { getWebView2Version } from "./lib/webview2.mjs";
import { defaultAppPath, E2E_DIR, e2eAppDataDir, e2eJournalDir } from "./lib/paths.mjs";

function log(msg) {
  console.log(`[e2e/run] ${msg}`);
}

function fail(msg) {
  console.error(`[e2e/run] ${msg}`);
  process.exit(1);
}

async function main() {
  const appPath = process.env.RUBRICA_E2E_EXE ?? defaultAppPath();
  if (!existsSync(appPath)) {
    fail(
      `No built app found at ${appPath}. Build it first: \`pnpm tauri build --debug\` ` +
        `(or set RUBRICA_E2E_EXE to point at an existing rubrica.exe).`,
    );
  }
  log(`Target app: ${appPath}`);

  log("Resolving the installed WebView2 Runtime version...");
  const webview2Version = getWebView2Version();
  log(`WebView2 Runtime: ${webview2Version} — downloading the matching msedgedriver (not the standalone Edge browser's version; see lib/webview2.mjs).`);
  const driverPath = await downloadEdgeDriver(webview2Version);
  log(`msedgedriver ready: ${driverPath}`);

  // Isolated journal/app-data dirs (never the developer machine's real %LOCALAPPDATA%\Rubrica /
  // %APPDATA%\Rubrica — see lib/paths.mjs's e2eJournalDir/e2eAppDataDir doc comment). tauri-driver
  // spawns the target app as its own child process, inheriting this env — the app process reads
  // RUBRICA_JOURNAL_DIR/RUBRICA_APPDATA_DIR (engine::journal / store) the same way it already
  // does for the Rust test suite's own fixtures.
  const journalDir = e2eJournalDir();
  const appDataDir = e2eAppDataDir();
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(appDataDir, { recursive: true });
  const appEnv = { ...process.env, RUBRICA_JOURNAL_DIR: journalDir, RUBRICA_APPDATA_DIR: appDataDir };

  // A CI runner's WebView2 can crash on launch without GPU acceleration available
  // ("Chrome instance exited" / "session not created" from msedgedriver) — WEBVIEW2_ADDITIONAL_
  // BROWSER_ARGUMENTS is the real WebView2 SDK env var for passing extra Chromium flags to the
  // embedded browser process; --disable-gpu is the standard fix for exactly this failure mode.
  // Harmless to always set (a real desktop session with a GPU ignores it fine too).
  appEnv.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--disable-gpu";

  log("Starting tauri-driver...");
  const tauriDriver = spawn("tauri-driver", ["--native-driver", driverPath], {
    stdio: ["ignore", "pipe", "pipe"],
    env: appEnv,
  });
  let tauriDriverOutput = "";
  tauriDriver.stdout.on("data", (chunk) => (tauriDriverOutput += chunk));
  tauriDriver.stderr.on("data", (chunk) => (tauriDriverOutput += chunk));

  const tauriDriverExited = new Promise((resolve) => tauriDriver.once("exit", resolve));
  tauriDriver.once("error", (err) => {
    fail(`Failed to start tauri-driver: ${err.message}. Is it installed? \`cargo install tauri-driver --locked\`.`);
  });

  // tauri-driver has no "ready" signal on stdout to wait for deterministically — a short,
  // fixed wait before the first connection attempt is what the official Tauri WebDriver
  // examples do too; wdio's own connectionRetryCount/Timeout (wdio.conf.mjs) absorbs the rest.
  await new Promise((resolve) => setTimeout(resolve, 2000));

  log("Running the WebdriverIO suite...");
  // Windows: a `.cmd` shim (what pnpm/npm put in node_modules/.bin for a bin script) is a batch
  // file, not a native executable — `spawn()` needs `shell: true` to run it directly, or it
  // fails immediately with EINVAL (confirmed by hand before landing this).
  const wdioBin = path.join(E2E_DIR, "..", "node_modules", ".bin", process.platform === "win32" ? "wdio.cmd" : "wdio");
  const wdio = spawn(wdioBin, ["run", path.join(E2E_DIR, "wdio.conf.mjs")], {
    cwd: E2E_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const exitCode = await new Promise((resolve) => wdio.once("exit", (code) => resolve(code ?? 1)));

  log("Stopping tauri-driver...");
  tauriDriver.kill();
  const [driverExitCode] = await Promise.race([Promise.all([tauriDriverExited]), new Promise((resolve) => setTimeout(() => resolve([null]), 5000))]);
  if (exitCode !== 0 && tauriDriverOutput.trim()) {
    log(`tauri-driver output (exit ${driverExitCode ?? "unknown"}):\n${tauriDriverOutput}`);
  }

  process.exit(exitCode);
}

main().catch((err) => {
  fail(err.stack ?? String(err));
});
