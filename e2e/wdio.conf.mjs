// WebdriverIO config for the tauri-driver-backed e2e suite (R8 deliverable 1). Invoked via
// `pnpm e2e` (see e2e/run.mjs, which resolves a matching msedgedriver and spawns tauri-driver
// itself before handing off to `wdio run` with this config) — never run this file's `wdio run`
// directly without that wrapper, or there will be no WebDriver server listening on port 4444 for
// this to connect to.
import { defaultAppPath } from "./lib/paths.mjs";
import { clearJournals, resetAppData } from "./lib/process.mjs";

export const config = {
  // Two real, self-inflicted bugs this suite found by running itself twice in a row — both are
  // real Windows filesystem/app-data state that outlives any one spec's session, so leftovers
  // from an earlier run (including this suite's own previous invocation) silently break the NEXT
  // one from its very first step:
  //   1. 06-recovery-a-kill.e2e.mjs deliberately leaves an autosave journal on disk (the whole
  //      point of that scenario) — CONTRACTS' journal is only ever deleted by a clean save, never
  //      by "recover and move on", so a leftover one makes every later launch boot straight into
  //      a blocking RecoveryDialog instead of the Home screen.
  //   2. 08-i18n-smoke.e2e.mjs's language switch calls the real prefs_set, which persists to
  //      %APPDATA%\Rubrica\rubrica.db across app restarts by design — left as English, every
  //      later launch's pt-PT selectors stop matching anything.
  // Reset both once, before the whole suite, rather than trusting every spec to leave the
  // environment exactly as clean as it found it.
  onPrepare: () => {
    clearJournals();
    resetAppData();
  },
  // tauri-driver listens on 127.0.0.1:4444 by default (e2e/run.mjs doesn't override this) — but
  // unlike a recognized `browserName`, webdriverio has no way to infer this on its own from a
  // bare `tauri:options` capability, so both must be explicit (confirmed by hand: omitting these
  // fails immediately with "No browserName defined in capabilities nor hostname or port found!").
  hostname: "127.0.0.1",
  port: 4444,
  specs: [process.env.RUBRICA_E2E_SPECS ?? "./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      "tauri:options": {
        application: process.env.RUBRICA_E2E_EXE ?? defaultAppPath(),
      },
    },
  ],
  logLevel: "warn",
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 120000,
  },
  // tauri-driver's WebDriver proxy doesn't support the plugin/vendor capabilities check
  // webdriverio's own "connectionRetryTimeout" default assumes for a browser session — a
  // generous number of session-start retries is worth it given the app itself can take a couple
  // seconds to compile-and-launch (Pdfium bind, journal scan, protocol registration) on first
  // connect, especially on a CI runner.
  connectionRetryTimeout: 30000,
  connectionRetryCount: 3,
};
