// Locale-aware string lookup for e2e selectors, so specs never hardcode a pt-PT (or en) string
// inline — the same risk CONTRACTS §7 calls out for the app's own UI code applies here too: a
// hardcoded string silently stops matching the moment a translation is reworded, and doing this
// makes the "both-language smoke" scenario (R8 deliverable 1) a matter of calling `t(lng, key)`
// with a different `lng`, not a second copy of every selector string.
//
// Reads the same namespace JSON files the app itself loads (`src/i18n/locales/<lng>/<ns>.json`),
// resolving the identical "namespace:namespace.section.key" convention `t()` uses at runtime
// (see src/i18n/index.ts / agents/reports/r1-report.md's "Key convention" note) — with one
// difference from react-i18next: no interpolation ({{var}}) support, since every string this
// suite matches against is a static UI label, never an interpolated one.
import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";

const cache = new Map();

function loadNamespace(lng, ns) {
  const cacheKey = `${lng}:${ns}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const file = path.join(REPO_ROOT, "src", "i18n", "locales", lng, `${ns}.json`);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  cache.set(cacheKey, parsed);
  return parsed;
}

/**
 * `t("pt-PT", "chrome:chrome.toolbar.save")` — same key shape the app's own `t()` calls use.
 * `vars`, when given, does simple `{{name}}` substitution (not full i18next interpolation/
 * pluralization) — enough for the handful of specs that need e.g. a page number in a label; for
 * a pluralized key (an i18next `_one`/`_other` suffix pair), pass the exact suffixed key instead
 * of trying to reproduce i18next's plural-selection rules here.
 */
export function t(lng, fullKey, vars) {
  const [ns, ...rest] = fullKey.split(":");
  if (rest.length === 0) throw new Error(`e2e t(): key "${fullKey}" is missing its "namespace:" prefix`);
  const dottedPath = rest.join(":");
  let node = loadNamespace(lng, ns);
  for (const segment of dottedPath.split(".")) {
    if (node == null || typeof node !== "object" || !(segment in node)) {
      throw new Error(`e2e t(): key "${fullKey}" not found in ${lng}/${ns}.json (stopped at "${segment}")`);
    }
    node = node[segment];
  }
  if (typeof node !== "string") throw new Error(`e2e t(): key "${fullKey}" resolved to a non-string value in ${lng}/${ns}.json`);
  if (!vars) return node;
  return Object.entries(vars).reduce((str, [name, value]) => str.replaceAll(`{{${name}}}`, String(value)), node);
}
