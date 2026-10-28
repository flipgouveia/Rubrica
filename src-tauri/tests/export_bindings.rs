//! Regenerates `src/ipc/bindings.ts` from the Rust command/event registry —
//! the single source of truth (CONTRACTS §1). Run via `pnpm
//! bindings:generate`. `scripts/check-bindings-drift.mjs` runs this in CI and
//! fails the build if the checked-in file doesn't match, so bindings.ts is
//! never hand-edited.

#[test]
fn export_bindings() {
    rubrica_lib::specta_builder()
        .export(
            specta_typescript::Typescript::default(),
            "../src/ipc/bindings.ts",
        )
        .expect("failed to export TypeScript bindings");
}
