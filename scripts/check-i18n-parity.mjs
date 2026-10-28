#!/usr/bin/env node
// CONTRACTS §7 / §9: CI check that every i18n namespace file under
// src/i18n/locales/pt-PT/ (the default language) has an exact key-set match
// in every other language directory under src/i18n/locales/ (currently just
// en/, but this generalizes to any further language added later — no edits
// needed here).
//
// This compares nested key *paths* only, not translated values: translators
// fill in the text, this script only guards against a namespace file
// drifting out of sync between languages (a key added/renamed/removed on
// one side and forgotten on the other).
//
// Node built-ins only (fs/path) — no new deps, works even before
// `pnpm install` has run.
//
// Wired up as `pnpm i18n:check` (see package.json).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = join(scriptDir, "..");
const LOCALES_DIR = join(REPO_ROOT, "src", "i18n", "locales");
const BASE_LANGUAGE = "pt-PT";

/** Directory names directly under `dir`. */
function listSubdirs(dir) {
  return readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
}

/** `.json` file names (without extension) directly under `dir`. */
function listNamespaces(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => basename(name, ".json"))
    .sort();
}

/**
 * Flatten a nested plain object into dotted leaf-key paths. An empty object
 * (an "empty-but-wired" namespace, `{}`) yields no paths, which is what lets
 * two empty namespace files compare as equal.
 */
function collectKeyPaths(value, prefix = "", out = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    out.push(prefix);
    return out;
  }
  for (const key of Object.keys(value)) {
    collectKeyPaths(value[key], prefix ? `${prefix}.${key}` : key, out);
  }
  return out;
}

function loadKeySet(filePath) {
  const raw = readFileSync(filePath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid JSON in ${filePath}: ${err.message}`);
  }
  return new Set(collectKeyPaths(parsed));
}

function main() {
  const languageDirs = listSubdirs(LOCALES_DIR);

  if (!languageDirs.includes(BASE_LANGUAGE)) {
    console.error(
      `i18n parity: base language directory "${BASE_LANGUAGE}" not found under ${LOCALES_DIR}`,
    );
    process.exitCode = 1;
    return;
  }

  const otherLanguages = languageDirs.filter((lng) => lng !== BASE_LANGUAGE);
  if (otherLanguages.length === 0) {
    console.error(
      `i18n parity: no language directories found next to "${BASE_LANGUAGE}" under ${LOCALES_DIR}`,
    );
    process.exitCode = 1;
    return;
  }

  const baseDir = join(LOCALES_DIR, BASE_LANGUAGE);
  const baseNamespaces = listNamespaces(baseDir);

  const problems = [];
  let namespacePairsChecked = 0;

  for (const language of otherLanguages) {
    const languageDir = join(LOCALES_DIR, language);
    const languageNamespaces = listNamespaces(languageDir);
    const allNamespaces = Array.from(
      new Set([...baseNamespaces, ...languageNamespaces]),
    ).sort();

    for (const namespace of allNamespaces) {
      const inBase = baseNamespaces.includes(namespace);
      const inLanguage = languageNamespaces.includes(namespace);

      if (!inBase) {
        problems.push(
          `[${namespace}] exists in "${language}/" but has no "${BASE_LANGUAGE}/${namespace}.json" counterpart`,
        );
        continue;
      }
      if (!inLanguage) {
        problems.push(
          `[${namespace}] exists in "${BASE_LANGUAGE}/" but is missing from "${language}/" (expected ${join(languageDir, `${namespace}.json`)})`,
        );
        continue;
      }

      namespacePairsChecked += 1;
      let baseKeys;
      let languageKeys;
      try {
        baseKeys = loadKeySet(join(baseDir, `${namespace}.json`));
        languageKeys = loadKeySet(join(languageDir, `${namespace}.json`));
      } catch (err) {
        problems.push(`[${namespace}] ${err.message}`);
        continue;
      }

      const missingInLanguage = [...baseKeys]
        .filter((key) => !languageKeys.has(key))
        .sort();
      const missingInBase = [...languageKeys]
        .filter((key) => !baseKeys.has(key))
        .sort();

      if (missingInLanguage.length > 0 || missingInBase.length > 0) {
        problems.push(`[${namespace}] ${BASE_LANGUAGE} <-> ${language} key mismatch:`);
        for (const key of missingInLanguage) {
          problems.push(`    missing in ${language}: ${key}`);
        }
        for (const key of missingInBase) {
          problems.push(`    missing in ${BASE_LANGUAGE}: ${key}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    console.error("i18n parity check FAILED\n");
    for (const line of problems) console.error(line);
    console.error(
      `\n${problems.length} issue line(s) found across ${otherLanguages.length} language pair(s) (base: ${BASE_LANGUAGE}). Fix the locale files above.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `i18n parity check OK — ${namespacePairsChecked} namespace(s) match across ${otherLanguages.length + 1} language(s) (${BASE_LANGUAGE} + ${otherLanguages.join(", ")}).`,
  );
}

main();
