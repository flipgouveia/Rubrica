//! R1's day-0 risk item: prove Tauri + `pdfium-render` + the vendored bblanchon
//! Pdfium binary actually build and link together on this machine, by opening a
//! tiny fixture PDF and reading its page count.
//!
//! Run with: `cargo test --manifest-path src-tauri/Cargo.toml --test pdfium_smoke`

use std::path::PathBuf;

#[test]
fn opens_tiny_fixture_and_reads_page_count() {
    let pdfium = rubrica_lib::engine::pdfium::bind(None)
        .expect("failed to bind to the vendored Pdfium library");

    let fixture: PathBuf = [
        env!("CARGO_MANIFEST_DIR"),
        "..",
        "fixtures",
        "smoke",
        "tiny.pdf",
    ]
    .iter()
    .collect();

    assert!(
        fixture.exists(),
        "smoke fixture missing at {}; see scripts/gen-smoke-fixture.py",
        fixture.display()
    );

    let document = pdfium
        .load_pdf_from_file(&fixture, None)
        .expect("failed to open tiny.pdf with pdfium");

    assert_eq!(
        document.pages().len(),
        2,
        "tiny.pdf was generated as a 2-page fixture"
    );
}
