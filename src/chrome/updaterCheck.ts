// R7 (Windows citizenship, deliverable 4): user-controlled update checking
// against GitHub Releases. `@tauri-apps/plugin-updater` is a separate Tauri
// plugin with its own JS bindings — invoked directly here, not through
// `src/ipc` (CONTRACTS' IPC surface is frozen and doesn't cover it). Reuses
// the existing `prefs_get`/`prefs_set` commands (CONTRACTS §3, app domain)
// for the "check on startup" pref rather than inventing new IPC, and R3's
// shared `pushToast` for the "never auto-install without consent" gesture —
// see `errors.tsx`'s own comment on reusing shared surfaces instead of
// hand-rolling more UI chrome.
//
// No Settings toggle exists yet for `updater.checkOnStartup` (that's real
// UI work in a file this wave doesn't own — see the R7 report); this
// defaults to "on" and honors the pref the moment a future Settings screen
// starts writing it.
import { isTauri } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { commands } from "../ipc";
import { pushToast } from "./toastStore";

const CHECK_ON_STARTUP_PREF = "updater.checkOnStartup";

async function shouldCheckOnStartup(): Promise<boolean> {
  const result = await commands.prefsGet(CHECK_ON_STARTUP_PREF);
  if (result.status === "error" || result.data == null) return true;
  try {
    return (JSON.parse(result.data) as unknown) !== false;
  } catch {
    return true;
  }
}

/**
 * Call once, on app mount. No-op outside a real Tauri window (mock/dev) and
 * in the portable build, where the updater plugin is never registered on
 * the Rust side (see `os_integration::is_portable`) — `check()`'s IPC call
 * simply rejects there, which this treats the same as "no update found"
 * rather than as an error worth surfacing.
 */
export async function startUpdaterCheck(): Promise<void> {
  if (!isTauri() || !(await shouldCheckOnStartup())) return;

  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check().catch(() => null);
  if (!update) return;

  pushToast({
    tone: "info",
    title: i18n.t("common:common.updater.available.title"),
    description: i18n.t("common:common.updater.available.description", {
      version: update.version,
    }),
    actionLabel: i18n.t("common:common.updater.available.action"),
    onAction: () => {
      // Windows: this exits Rubrica once the downloaded installer has
      // launched, and the installer's own passive UI relaunches it — see
      // tauri.conf.json's plugins.updater.windows.installMode and
      // @tauri-apps/plugin-updater's own docs on downloadAndInstall.
      void update.downloadAndInstall().catch(() => {
        pushToast({
          tone: "danger",
          title: i18n.t("common:common.updater.installFailed.title"),
          description: i18n.t("common:common.updater.installFailed.description"),
        });
      });
    },
  });
}
