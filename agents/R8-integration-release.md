# R8 — Integration & release (wave 3, runs after wave 2 is merged)

## Mission

Turn the merged waves into Rubrica 0.1.0. You are the only agent allowed to touch cross-cutting
seams. Integration waves in projects like this typically surface bugs that no unit suite can
catch — expect that class here: mock-vs-
real drift, protocol/URL edge cases, focus and shortcut collisions between tools, i18n gaps.
Discipline: trivial cross-boundary fixes (≤ ~5 lines) with a note; anything larger is filed
precisely in your report, not refactored unilaterally.

## Read first

Every report in `agents/reports/`, `agents/CONTRACTS.md`, `docs/ARCHITECTURE.md`.

## Owns

`e2e/`, `docs/`, README, CHANGELOG, version bump + tag prep; cross-cutting glue (shortcut-map
consolidation, mock exclusion from production build, dead-flag cleanup); the release checklist.

## Deliverables

1. **Full-app e2e** via `tauri-driver` + WebdriverIO on `windows-latest`: open fixture → scroll/
   zoom/search → annotate (each type once) → reorder + delete pages → fill the government form →
   edit a text run → redact a term → save → reopen → assert everything survived; plus recovery
   (kill mid-edit, journal replay) and both-language smoke (switch to en, core flows still work).
2. **Performance pass**: 500-page fixture budgets — cold open < 1.5 s to first page, scroll with
   no visible tile starvation at 1× on dev hardware, memory flat over a 10-minute scroll session
   (no tile-cache leak). Fix within your seams; file engine-level findings.
3. **Mock hygiene**: mock engine excluded from production bundles (size check in CI), still
   first-class for `pnpm dev`.
4. **The portability release checklist**, executed and recorded: every artifact class produced
   by the e2e (annotated, page-edited, form-filled, text-edited, redacted, mixed) opened in
   Acrobat Reader and a Chromium browser — a human does the final visual pass; you prepare the
   files, the checklist, and record automated verification (fresh-PDFium reopen + verify-pdf).
5. **Keyboard & i18n audit**: every tool reachable keyboard-only; shortcut collisions resolved
   via R3's map; pt-PT/en parity green; no hardcoded strings (lint proves it).
6. **Release**: README (real product doc), CHANGELOG from wave reports, version 0.1.0
   everywhere, draft release via R7's pipeline with both bundles; open-issues list for the
   backlog seeded from all reports.

## Dependencies you may add

`tauri-driver`, `webdriverio` (+ msedgedriver setup for CI).

## Subagent plan

- SA-1: e2e harness bring-up (tauri-driver on CI is the risk item — start first).
- SA-2: e2e scenarios.
- SA-3: performance pass + mock hygiene.
- SA-4: docs/README/CHANGELOG + portability checklist prep.
- Keep for yourself: bug triage across seams, the final full-suite + bundle verification.

## Definition of done

- e2e green on `windows-latest` against the real built app; performance budgets met and
  recorded with numbers in the report.
- Draft 0.1.0 release with installer + portable artifacts; portability checklist file committed
  with automated columns filled and the manual Acrobat/browser column ready for the owner.
- Write `agents/reports/r8-report.md` + backlog list (include: visual signatures as the first
  post-v1 feature, Authenticode decision).
