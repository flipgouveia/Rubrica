// Rubrica i18n bootstrap (CONTRACTS §7).
//
// This module's only job is to initialize react-i18next as a side effect of
// being imported (see src/main.tsx: `import "./i18n"` runs before anything
// renders). Desktop app, no server — every namespace for every language is
// bundled at build time via `import.meta.glob`, eagerly, so there is no
// runtime fetch and no loading flicker.
//
// Namespace discovery is automatic: drop a new file at
// `src/i18n/locales/<lng>/<namespace>.json` and it is picked up here with
// zero edits to this file. The set of known namespaces is whatever files
// exist under `locales/pt-PT/` (see CONTRACTS §7 for the fixed list each
// area owns) — every other language is expected to mirror that same file
// list, and `scripts/check-i18n-parity.mjs` enforces it in CI.
import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const DEFAULT_LANGUAGE = "pt-PT";
export const FALLBACK_LANGUAGE = "en";

type NamespaceResources = Record<string, unknown>;
type LanguageResources = Record<string, NamespaceResources>;

// Matches "./locales/<lng>/<namespace>.json" as produced by the glob below.
const LOCALE_FILE_PATTERN = /\.\/locales\/([^/]+)\/([^/]+)\.json$/;

const localeModules = import.meta.glob("./locales/*/*.json", {
  eager: true,
}) as Record<string, { default: NamespaceResources }>;

const resources: Record<string, LanguageResources> = {};
const namespaces = new Set<string>();

for (const [path, module] of Object.entries(localeModules)) {
  const match = LOCALE_FILE_PATTERN.exec(path);
  if (!match) continue;
  const [, language, namespace] = match;
  resources[language] ??= {};
  resources[language][namespace] = module.default;
  namespaces.add(namespace);
}

void i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LANGUAGE,
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: [DEFAULT_LANGUAGE, FALLBACK_LANGUAGE],
  ns: Array.from(namespaces),
  defaultNS: "common",
  interpolation: {
    // React already escapes interpolated values.
    escapeValue: false,
  },
  returnEmptyString: false,
});

export default i18n;
