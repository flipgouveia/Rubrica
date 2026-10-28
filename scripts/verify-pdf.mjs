#!/usr/bin/env node
// scripts/verify-pdf.mjs
//
// The "parses with pdf-lib" half of CONTRACTS.md §9's portability gate:
//
//   "Portability gate for anything written: output re-opens in a fresh
//    PDFium instance AND parses with pdf-lib (node script
//    scripts/verify-pdf.mjs, R1-provided)"
//
// This script only covers the pdf-lib half. The PDFium half (re-opening the
// same file in a fresh PDFium instance) is a Rust-side concern owned by the
// engine agent(s) building on top of pdfium-render — it is NOT implemented
// here. Treat a clean run of this script as necessary, not sufficient, for
// the full portability gate.
//
// Usage:
//   node scripts/verify-pdf.mjs [file ...]
//   pnpm verify:pdf [file ...]
//
// With no arguments, every *.pdf directly under fixtures/ is checked, except
// corrupt.pdf and encrypted.pdf — those two are EXPECTED to fail a naive
// `PDFDocument.load()` (that is the entire point of those two fixtures) and
// are reported as "expected-fail, skipped" rather than counted as failures.
// Passing a file explicitly on the command line always attempts to load it
// for real, expected-fail list included — this script does not silently
// skip files you named yourself.

import { readFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'fixtures');

// Fixtures that are deliberately unparseable by a naive load and should be
// reported as expected failures rather than real ones, when auto-discovered.
const EXPECTED_FAIL_BASENAMES = new Set(['corrupt.pdf', 'encrypted.pdf']);

async function discoverDefaultTargets() {
  const entries = await readdir(FIXTURES_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map((e) => path.join(FIXTURES_DIR, e.name))
    .sort();
}

async function verifyOne(filePath, { autoDiscovered }) {
  const base = path.basename(filePath);
  const relPath = path.relative(REPO_ROOT, filePath);

  if (autoDiscovered && EXPECTED_FAIL_BASENAMES.has(base)) {
    return { file: relPath, status: 'skipped', reason: 'expected-fail fixture' };
  }

  let bytes;
  try {
    bytes = await readFile(filePath);
  } catch (err) {
    return { file: relPath, status: 'fail', reason: `could not read file: ${err.message}` };
  }

  try {
    // ignoreEncryption: false so an encrypted document correctly throws
    // instead of silently loading with garbage/undecrypted content.
    const doc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    const pageCount = doc.getPageCount();
    return { file: relPath, status: 'pass', reason: `parsed OK (${pageCount} page(s))` };
  } catch (err) {
    return { file: relPath, status: 'fail', reason: err.message };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const autoDiscovered = args.length === 0;

  const targets = autoDiscovered
    ? await discoverDefaultTargets()
    : args.map((a) => path.resolve(process.cwd(), a));

  if (targets.length === 0) {
    console.error('No PDF files found to verify.');
    process.exitCode = 1;
    return;
  }

  const results = [];
  for (const target of targets) {
    results.push(await verifyOne(target, { autoDiscovered }));
  }

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : r.status === 'skipped' ? 'SKIP' : 'FAIL';
    console.log(`[${icon}] ${r.file} — ${r.reason}`);
    if (r.status === 'pass') passed++;
    else if (r.status === 'skipped') skipped++;
    else failed++;
  }

  console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log('(pdf-lib check only — the PDFium re-open half of the portability gate is not covered here.)');

  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('scripts/verify-pdf.mjs crashed:', err);
  process.exitCode = 1;
});
