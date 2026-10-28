// Resolves the version of the installed WebView2 Runtime — the actual engine a Tauri app on
// Windows embeds and that `tauri-driver` needs a matching `msedgedriver.exe` for.
//
// This is NOT the same thing as the standalone Edge browser's version, and the two can drift:
// confirmed on the machine this e2e suite was first built on, where standalone Edge
// (`Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, what the `edgedriver` npm
// package's own auto-detection reads) reported 152.0.4191.66 while the WebView2 Runtime — read
// from the registry key below, the one Tauri's own bundler and every WebView2 app on the system
// actually use — reported 153.0.4234.32. Downloading a driver matched to the wrong one fails to
// attach to the WebView2 process at session-creation time (a real major-version mismatch, not a
// cosmetic one), so this deliberately does NOT use `edgedriver`'s built-in detection.
//
// The registry key is the WebView2 "Evergreen" Runtime's own product GUID — documented by
// Microsoft (see "Registry: pv value" in the WebView2 distribution docs) and stable across
// Windows versions; present on every `windows-latest` GitHub Actions runner, which ships WebView2
// preinstalled (same as every real Windows 11 install — see docs/ARCHITECTURE.md's stack table).
import { execFileSync } from "node:child_process";

const WEBVIEW2_CLIENT_KEY = "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

export function getWebView2Version() {
  const script = `(Get-ItemProperty '${WEBVIEW2_CLIENT_KEY}').pv`;
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  const version = out.trim();
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Could not resolve the installed WebView2 Runtime version (got: ${JSON.stringify(version)}). Is WebView2 installed? See https://developer.microsoft.com/microsoft-edge/webview2/`);
  }
  return version;
}
