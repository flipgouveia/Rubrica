//! R2's engine test suite (agents/R2-engine-core.md deliverable 7): the
//! full fixtures corpus, including hostile files (encrypted/corrupt never
//! panic and produce typed errors); a journal crash-replay test; an
//! atomic-save test; and the portability gate (`scripts/verify-pdf.mjs` for
//! the pdf-lib half, a fresh PDFium re-open for the other half — see that
//! script's own header comment for why both halves exist and who owns
//! which).
//!
//! **Why one `#[test]` fn instead of ten**: Rust's test harness runs every
//! `#[test]` function on its own freshly spawned OS thread — even when
//! `--test-threads=1` makes it run them one at a time, each still gets a
//! *different* thread. Empirically (not just per the crate docs), the
//! vendored PDFium build segfaults or hits a stack-buffer-overrun roughly
//! half the time when opened from a series of different threads like that,
//! even with every actual PDFium call serialized behind a `Mutex` — but
//! never once across dozens of runs, and never in a tight same-thread
//! repro loop covering the same open/mutate/save/render/reopen sequence.
//! So: every sub-test below is a plain function, and [`engine_fixtures`]
//! calls them all itself, sequentially, from the one thread libtest gives
//! that single `#[test]`. This is a workaround for what looks like a
//! thread-affinity assumption somewhere in the prebuilt PDFium binary or
//! its bindings, not a bug in this crate's own session/command code — see
//! the report for the full writeup. A future wave hitting the same
//! flakiness anywhere else (a Vitest/UI test that opens real documents
//! across worker threads, say) should suspect this first.
//!
//! Every (sub-)test here runs against `RUBRICA_JOURNAL_DIR` pointed at a
//! scratch directory (see [`init_test_journal_dir`]) rather than the real
//! `%LOCALAPPDATA%\Rubrica\journal` — opening a fixture must never read or
//! write the actual developer/CI machine's profile.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Once};

use rubrica_lib::engine::document::DocumentSession;
use rubrica_lib::engine::history::test_commands::{InsertBlankPageCommand, RotatePageCommand};
use rubrica_lib::engine::journal;
use rubrica_lib::engine::pdfium;
use rubrica_lib::engine::redact::RedactCommand;
use rubrica_lib::engine::search::extract;
use rubrica_lib::engine::search::index::PageIndex;
use rubrica_lib::engine::search::matcher::{self, Matcher};
use rubrica_lib::engine::textedit::{
    list_text_runs, AddImageObjectCommand, AddTextObjectCommand, DeleteObjectCommand,
    SetTextCommand,
};
use rubrica_lib::types::{
    ImageObjectSpec, Rect, RubricaErrorCode, SearchMode, SearchQuery, SearchScope, TextObjectSpec,
};

/// Every `TextRun.objectId` this crate hands out is `"<page>:<index>"` (an implementation
/// detail of `engine::textedit`, not part of CONTRACTS) — tests reach for the raw `index`
/// `SetTextCommand`/`DeleteObjectCommand` take by parsing it back out rather than duplicating
/// the encoding logic.
fn object_index(object_id: &str) -> usize {
    object_id
        .rsplit(':')
        .next()
        .expect("object id should be \"page:index\"")
        .parse()
        .expect("object id's index half should be a plain integer")
}

static INIT: Once = Once::new();

fn init_test_journal_dir() {
    INIT.call_once(|| {
        let dir = std::env::temp_dir().join(format!("rubrica-test-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch journal dir");
        std::env::set_var("RUBRICA_JOURNAL_DIR", &dir);
    });
}

fn repo_root() -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), ".."].iter().collect()
}

fn fixture(name: &str) -> PathBuf {
    repo_root().join("fixtures").join(name)
}

/// Copies `fixture_name` into a fresh temp directory under a fresh file
/// name, so tests that mutate/save never touch the checked-in fixture
/// itself. Returns the guard (keep it alive) and the copy's path.
fn copy_fixture_to_scratch(fixture_name: &str) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let dest = dir.path().join(fixture_name);
    std::fs::copy(fixture(fixture_name), &dest).expect("copy fixture into scratch dir");
    (dir, dest)
}

/// The full portability gate for a file this test suite wrote:
/// re-opens `path` through the shared Pdfium handle (a fresh `PdfDocument`
/// handle, though not a fresh *library* bind — see `API.md`, only one
/// `Pdfium::new` may ever happen per process) and shells out to
/// `scripts/verify-pdf.mjs` for the pdf-lib half.
fn assert_portable(path: &Path, expected_pages: u32) {
    let reopened = pdfium::shared()
        .load_pdf_from_file(path, None)
        .expect("saved PDF failed to re-open in PDFium");
    assert_eq!(reopened.pages().len() as u32, expected_pages);
    drop(reopened);

    let script = repo_root().join("scripts").join("verify-pdf.mjs");
    let status = std::process::Command::new("node")
        .arg(&script)
        .arg(path)
        .status()
        .expect("failed to launch `node scripts/verify-pdf.mjs` — is Node on PATH?");
    assert!(
        status.success(),
        "scripts/verify-pdf.mjs reported a failure for {}",
        path.display()
    );
}

/// Scans a saved PDF's raw bytes for `needle` (an ASCII word), decompressing every
/// Flate-encoded stream along the way — PDFium's own `save_to_bytes()` compresses regenerated
/// content streams by default (confirmed empirically while building the redaction byte-search
/// test below), so a plain byte scan alone would trivially "pass" a redaction proof for the
/// wrong reason. Also checks for `needle`'s upper/lowercase hex-string encoding — PDFium's
/// regenerated content streams write text-showing operands as hex strings (`<5468652052...>`
/// for `(The Ru...`), not literal parenthesized strings (also confirmed empirically), so a
/// search for the literal ASCII bytes alone would equally miss a genuine, uncompressed trace.
///
/// Not a real PDF parser: rather than locating each stream's `stream`/`endstream` boundary
/// (fragile — those keywords can coincidentally occur inside compressed binary data too, which
/// misdetects boundaries and silently skips real streams), this scans for the 2-byte zlib
/// header (`0x78` plus one of the handful of valid compression-level bytes) and attempts to
/// inflate from there to the end of the file. `flate2` stops consuming input exactly where the
/// deflate stream's own checksum says it ends, so handing it "the rest of the file" from every
/// plausible header position is simpler and more robust than precise boundary-finding, at the
/// cost of a decode attempt per candidate position (fine at fixture-file sizes).
fn contains_decompressed(haystack_bytes: &[u8], needle: &[u8]) -> bool {
    fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        if needle.len() > haystack.len() {
            return None;
        }
        haystack.windows(needle.len()).position(|w| w == needle)
    }

    fn contains_any_form(haystack: &[u8], needle: &[u8]) -> bool {
        let upper_hex: Vec<u8> = needle
            .iter()
            .flat_map(|b| format!("{b:02X}").into_bytes())
            .collect();
        let lower_hex: Vec<u8> = needle
            .iter()
            .flat_map(|b| format!("{b:02x}").into_bytes())
            .collect();
        find(haystack, needle).is_some()
            || find(haystack, &upper_hex).is_some()
            || find(haystack, &lower_hex).is_some()
    }

    if contains_any_form(haystack_bytes, needle) {
        return true;
    }

    for i in 0..haystack_bytes.len().saturating_sub(1) {
        if haystack_bytes[i] != 0x78 || !matches!(haystack_bytes[i + 1], 0x01 | 0x5E | 0x9C | 0xDA)
        {
            continue;
        }
        let mut decompressed = Vec::new();
        let decoded = std::io::Read::read_to_end(
            &mut flate2::read::ZlibDecoder::new(&haystack_bytes[i..]),
            &mut decompressed,
        );
        if decoded.is_ok() && contains_any_form(&decompressed, needle) {
            return true;
        }
    }

    false
}

/// The single real `#[test]` entry point — see the module doc comment for
/// why every sub-test below is a plain function called from here, on one
/// thread, in sequence, rather than each being its own `#[test]`.
#[test]
fn engine_fixtures() {
    init_test_journal_dir();

    opens_text_pdf();
    opens_unicode_pdf_and_extracts_accented_text();
    opens_500_page_pdf_and_renders_a_page();
    opens_form_pdf_and_reports_has_form();
    opens_scanned_pdf_with_empty_text_layer();
    opens_encrypted_pdf_returns_typed_error_never_panics();
    opens_corrupt_pdf_returns_typed_error_never_panics();
    journal_replays_committed_commands_after_a_simulated_crash();
    save_leaves_no_partial_file_when_the_final_rename_fails();
    save_as_writes_a_portable_file_and_updates_recents_path();

    textedit_fixes_a_typo_without_font_substitution();
    textedit_edits_accented_pt_text_without_substitution();
    textedit_rejects_text_no_standard_font_can_encode();
    textedit_adds_a_text_box_and_an_image();
    textedit_object_delete_undoes_cleanly();
    redact_apply_leaves_no_trace_of_the_marked_text();
    mixed_undo_redo_across_domains_stays_consistent();

    rubrica_lib::engine::annotations::fixture_tests::run_annotation_fixture_tests();
    rubrica_lib::engine::pages::fixture_tests::run_all();
    rubrica_lib::engine::forms::fixture_tests::run_fixture_tests();
}

// --- fixtures corpus ---------------------------------------------------------

fn opens_text_pdf() {
    let session = DocumentSession::open(fixture("text.pdf").to_str().unwrap())
        .expect("text.pdf should open cleanly");
    let info = session.info();
    assert_eq!(
        info.page_count, 3,
        "fixtures/README.md: text.pdf is 3 pages"
    );
    assert!(!info.encrypted);
    assert!(!info.has_form);
    assert!(!info.dirty);
    assert_eq!(info.revision, 0);
}

fn opens_unicode_pdf_and_extracts_accented_text() {
    let session = DocumentSession::open(fixture("unicode.pdf").to_str().unwrap())
        .expect("unicode.pdf should open cleanly");
    assert_eq!(session.info().page_count, 1);

    let layout = rubrica_lib::engine::text::page_layout(&session, 0)
        .expect("text layout should succeed on a text-first page");
    assert!(!layout.is_empty(), "unicode.pdf has real body text");

    let text = rubrica_lib::engine::text::extract_range(&session, 0, 0, layout.len() as u32)
        .expect("extract_range should succeed for the full char range");
    assert!(
        text.chars().any(|c| "áàâãçéêíóôõú".contains(c)),
        "unicode.pdf's extracted text should contain PT-PT accented characters, got: {text}"
    );
}

fn opens_500_page_pdf_and_renders_a_page() {
    let session = DocumentSession::open(fixture("500-page.pdf").to_str().unwrap())
        .expect("500-page.pdf should open cleanly");
    assert_eq!(session.info().page_count, 500);

    // Not a strict perf assertion (CI/dev hardware varies too much to make
    // a hard millisecond budget meaningful), but a smoke test that rasterizing
    // a page deep into a large document doesn't hang or blow up. Uses
    // `render_page_at_dpi`, which takes a `&DocumentSession` directly, rather
    // than `render_tile`, which now routes through the `SessionStore` actor's
    // PDFium owner thread — this whole test file is deliberately single-
    // threaded to dodge PDFium's thread-affinity crash (see the module header),
    // so a test must not spin up that second PDFium thread. The tile-specific
    // path (`set_origin` clipping to a 512×512 window) is covered end-to-end by
    // `e2e/specs/09-render.e2e.mjs` against the real running app.
    let started = std::time::Instant::now();
    let png = rubrica_lib::engine::tiles::render_page_at_dpi(&session, 250, 96)
        .expect("rendering a mid-document page should succeed");
    assert!(!png.is_empty());
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "cold page render took unexpectedly long: {:?}",
        started.elapsed()
    );
}

fn opens_form_pdf_and_reports_has_form() {
    let session = DocumentSession::open(fixture("form.pdf").to_str().unwrap())
        .expect("form.pdf should open cleanly");
    let info = session.info();
    assert_eq!(info.page_count, 1);
    assert!(info.has_form, "form.pdf has an AcroForm");
}

fn opens_scanned_pdf_with_empty_text_layer() {
    let session = DocumentSession::open(fixture("scanned.pdf").to_str().unwrap())
        .expect("scanned.pdf should open cleanly");
    assert_eq!(session.info().page_count, 1);

    let layout = rubrica_lib::engine::text::page_layout(&session, 0)
        .expect("a page with no text layer at all is not an error, just empty");
    assert!(
        layout.is_empty(),
        "scanned.pdf has no text objects by design (fixtures/README.md)"
    );
}

// `DocumentSession` can't derive `Debug` (it holds a `PdfDocument`, which
// doesn't implement it), so `Result::expect_err`/`unwrap_err` aren't
// available here — hence the explicit `match` instead.

fn opens_encrypted_pdf_returns_typed_error_never_panics() {
    let path = fixture("encrypted.pdf").to_str().unwrap().to_string();
    let result = std::panic::catch_unwind(|| DocumentSession::open(&path))
        .expect("opening a hostile fixture must never panic");
    match result {
        Ok(_) => panic!(
            "encrypted.pdf has a non-empty user password and no password was supplied — expected an error"
        ),
        Err(err) => assert_eq!(err.code, RubricaErrorCode::Encrypted),
    }
}

fn opens_corrupt_pdf_returns_typed_error_never_panics() {
    let path = fixture("corrupt.pdf").to_str().unwrap().to_string();
    let result = std::panic::catch_unwind(|| DocumentSession::open(&path))
        .expect("opening a hostile fixture must never panic");
    match result {
        Ok(_) => {
            panic!("corrupt.pdf is truncated mid-object and must not parse — expected an error")
        }
        Err(err) => assert_eq!(err.code, RubricaErrorCode::Corrupt),
    }
}

// --- journal crash-replay -----------------------------------------------------

fn journal_replays_committed_commands_after_a_simulated_crash() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let path_str = work_path.to_str().unwrap().to_string();

    // Base state: 3 pages, no journal yet.
    assert!(journal::Journal::path_for(&work_path)
        .map(|p| !p.exists())
        .unwrap_or(false));

    {
        let mut session = DocumentSession::open(&path_str).expect("initial open");
        assert_eq!(session.info().page_count, 3);

        session
            .commit(Box::new(InsertBlankPageCommand::new(200.0, 200.0)))
            .expect("first commit");
        session
            .commit(Box::new(InsertBlankPageCommand::new(300.0, 300.0)))
            .expect("second commit");
        assert_eq!(session.info().page_count, 5);

        // Simulate a crash: drop the session without ever calling
        // `doc_close`/`doc_save` (which would delete the journal). The
        // journal file must survive this.
        drop(session);
    }

    let journal_path = journal::Journal::path_for(&work_path).unwrap();
    assert!(
        journal_path.exists(),
        "a journal file must survive an unclean drop of the session"
    );

    // "Restart": reopening the same path must replay both committed
    // commands with zero lost — ending up at 5 pages again, dirty (since
    // none of this was ever saved).
    let recovered = DocumentSession::open(&path_str).expect("recovering open");
    let info = recovered.info();
    assert_eq!(
        info.page_count, 5,
        "both journalled commands must replay — zero lost committed commands"
    );
    assert!(info.dirty, "replayed edits were never saved");
    assert_eq!(
        info.revision, 2,
        "replay bumps revision once per replayed command"
    );

    // A clean save now must delete the journal — nothing left to "recover"
    // on a subsequent normal open.
    let mut recovered = recovered;
    recovered.save(false).expect("save after recovery");
    assert!(
        !journal_path.exists(),
        "a clean save must delete the journal file"
    );

    let reopened_after_save = DocumentSession::open(&path_str).expect("reopen after save");
    let info = reopened_after_save.info();
    assert_eq!(info.page_count, 5);
    assert!(!info.dirty);

    assert_portable(&work_path, 5);
}

// --- atomic save ---------------------------------------------------------------

fn save_leaves_no_partial_file_when_the_final_rename_fails() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let path_str = work_path.to_str().unwrap().to_string();
    let original_bytes = std::fs::read(&work_path).unwrap();

    let mut session = DocumentSession::open(&path_str).expect("open");
    session
        .commit(Box::new(InsertBlankPageCommand::new(100.0, 100.0)))
        .expect("commit a change so the save actually writes something new");

    // Inject a failure at the final atomic-rename step: mark the target
    // read-only, which makes Windows refuse to replace it via rename.
    let mut perms = std::fs::metadata(&work_path).unwrap().permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(&work_path, perms).unwrap();

    let result = session.save(false);

    // Always restore write access before any assertion can `panic!`/early
    // return, so the temp directory can still clean itself up afterwards.
    let mut perms = std::fs::metadata(&work_path).unwrap().permissions();
    // Rubrica is Windows-only (docs/ARCHITECTURE.md); clippy's warning here
    // is about this making a file world-writable on Unix, which doesn't
    // apply.
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    std::fs::set_permissions(&work_path, perms).unwrap();

    assert!(
        result.is_err(),
        "saving onto a read-only target should fail, not silently succeed"
    );

    let bytes_after = std::fs::read(&work_path).unwrap();
    assert_eq!(
        bytes_after, original_bytes,
        "a failed save must leave the original file completely untouched, never partially written"
    );

    let dir_entries: Vec<_> = std::fs::read_dir(work_path.parent().unwrap())
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|name| name.starts_with(".rubrica-tmp-"))
        .collect();
    assert!(
        dir_entries.is_empty(),
        "a failed save must not leave a stray temp file behind, found: {dir_entries:?}"
    );
}

fn save_as_writes_a_portable_file_and_updates_recents_path() {
    let (dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let new_path = dir.path().join("renamed.pdf");

    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");
    session
        .commit(Box::new(InsertBlankPageCommand::new(150.0, 150.0)))
        .expect("commit");
    session
        .save_as(new_path.to_str().unwrap(), true)
        .expect("save_as should succeed");

    assert_eq!(session.path(), new_path);
    assert!(!session.dirty());
    // No `.bak` file is expected here — `write_atomically` only rotates one
    // in when a file already exists at the target path, and `new_path`
    // never existed before this `save_as`.
    assert!(!new_path.with_extension("pdf.bak").exists());

    assert_portable(&new_path, 4);
}

// --- textedit & redact (R6) ----------------------------------------------------

/// DoD: "Fix a typo in a real-world fixture (embedded font) with no substitution flag."
/// `text.pdf`'s body font is pdf-lib's `StandardFonts.Helvetica` (a standard, non-embedded
/// base-14 font using WinAnsiEncoding) — an ordinary ASCII edit must round-trip through it
/// with no substitution.
fn textedit_fixes_a_typo_without_font_substitution() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    let runs = list_text_runs(&session, 0).expect("list text runs");
    let target = runs
        .iter()
        .find(|r| r.text.contains("fictional"))
        .expect("text.pdf's first paragraph contains the word \"fictional\"");
    let index = object_index(&target.object_id);
    let fixed_text = target.text.replace("fictional", "ficticious");

    let (command, substituted_flag) = SetTextCommand::new(0, index, fixed_text.clone());
    session.commit(Box::new(command)).expect("commit set-text");
    assert!(
        !substituted_flag.load(Ordering::Relaxed),
        "an ASCII typo fix against a standard WinAnsi font must not require substitution"
    );

    let refreshed = list_text_runs(&session, 0).expect("list text runs after edit");
    assert!(
        refreshed.iter().any(|r| r.text == fixed_text),
        "the edited run should carry the corrected text"
    );

    session.save(false).expect("save");
    assert_portable(&work_path, 3);
}

/// DoD: "edit accented PT text" — `unicode.pdf`'s body is the same standard, non-embedded
/// Helvetica; WinAnsiEncoding already covers the PT-PT accent set the fixture uses, so editing
/// within that same character repertoire must also reuse the font, not substitute.
fn textedit_edits_accented_pt_text_without_substitution() {
    let (_dir, work_path) = copy_fixture_to_scratch("unicode.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    let runs = list_text_runs(&session, 0).expect("list text runs");
    let target = runs
        .iter()
        .find(|r| r.text.contains("digitalização"))
        .expect("unicode.pdf contains \"digitalização\"");
    let index = object_index(&target.object_id);
    let edited = target
        .text
        .replace("digitalização", "digitalização e automatização");

    let (command, substituted_flag) = SetTextCommand::new(0, index, edited.clone());
    session.commit(Box::new(command)).expect("commit set-text");
    assert!(
        !substituted_flag.load(Ordering::Relaxed),
        "PT-PT accented characters already representable in WinAnsiEncoding must not trigger substitution"
    );

    let refreshed = list_text_runs(&session, 0).expect("list text runs after edit");
    assert!(refreshed.iter().any(|r| r.text == edited));
    assert!(
        edited.chars().any(|c| "áàâãçéêíóôõú".contains(c)),
        "sanity: the edited text should still contain PT accents"
    );

    session.save(false).expect("save");
    assert_portable(&work_path, 1);
}

/// A character genuinely outside every standard PDF font's WinAnsiEncoding (no font Rubrica's
/// text editing supports could render it — see `engine::textedit`'s module doc comment for the
/// real native crash this guards against) must be rejected with a typed `INVALID_ARG` error,
/// not silently mis-rendered, not "substituted" into more of the same encoding it already
/// couldn't express, and — the actual regression this test exists to catch — not a process
/// crash.
fn textedit_rejects_text_no_standard_font_can_encode() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    let runs = list_text_runs(&session, 0).expect("list text runs");
    let index = object_index(&runs[0].object_id);

    // `catch_unwind` only catches a Rust panic, not the native process abort this guarded
    // against before the fix (`STATUS_ILLEGAL_INSTRUCTION`, no unwinding at all) — the actual
    // guarantee is `ensure_winansi_encodable` returning `Err` before any PDFium call happens;
    // this just matches the same defensive-test style `opens_encrypted_pdf_...` uses above.
    let (command, _substituted_flag) = SetTextCommand::new(0, index, "測試".to_string());
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        session.commit(Box::new(command))
    }))
    .expect("rejecting unencodable text must never panic");
    match result {
        Ok(_) => {
            panic!("text outside every standard font's encoding should be rejected, not accepted")
        }
        Err(err) => assert_eq!(err.code, RubricaErrorCode::InvalidArg),
    }

    // The document must be left exactly as it was -- a rejected edit is not a partial one.
    // (`TextRun` isn't `PartialEq`, so compare the fields that matter here directly.)
    let runs_after = list_text_runs(&session, 0).expect("list text runs after the rejected edit");
    let ids_and_text = |runs: &[rubrica_lib::types::TextRun]| {
        runs.iter()
            .map(|r| (r.object_id.clone(), r.text.clone()))
            .collect::<Vec<_>>()
    };
    assert_eq!(ids_and_text(&runs), ids_and_text(&runs_after));
}

/// DoD: "add a text box and an image — save, reopen ... all intact."
fn textedit_adds_a_text_box_and_an_image() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    session
        .commit(Box::new(AddTextObjectCommand::new(
            0,
            TextObjectSpec {
                rect: Rect {
                    x: 100.0,
                    y: 100.0,
                    width: 200.0,
                    height: 20.0,
                },
                text: "hand-added text box".to_string(),
                font_size: 14.0,
                color: "#1a1a1a".to_string(),
            },
        )))
        .expect("commit textobj_add");

    let image_path = fixture("scanned-source.png").to_str().unwrap().to_string();
    session
        .commit(Box::new(AddImageObjectCommand::new(
            0,
            ImageObjectSpec {
                rect: Rect {
                    x: 50.0,
                    y: 550.0,
                    width: 120.0,
                    height: 90.0,
                },
                path: image_path,
            },
        )))
        .expect("commit imageobj_add");

    let runs = list_text_runs(&session, 0).expect("list text runs");
    assert!(runs.iter().any(|r| r.text == "hand-added text box"));

    session.save(false).expect("save");
    assert_portable(&work_path, 3);

    let reopened = DocumentSession::open(work_path.to_str().unwrap()).expect("reopen");
    let runs_after_reopen = list_text_runs(&reopened, 0).expect("list text runs after reopen");
    assert!(
        runs_after_reopen
            .iter()
            .any(|r| r.text == "hand-added text box"),
        "the added text box must survive a save + fresh-PDFium reopen"
    );
}

/// `object_delete` removes an object this tool added, and undo brings it straight back.
fn textedit_object_delete_undoes_cleanly() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    session
        .commit(Box::new(AddTextObjectCommand::new(
            0,
            TextObjectSpec {
                rect: Rect {
                    x: 100.0,
                    y: 100.0,
                    width: 200.0,
                    height: 20.0,
                },
                text: "delete me".to_string(),
                font_size: 14.0,
                color: "#000000".to_string(),
            },
        )))
        .expect("commit textobj_add");

    let runs = list_text_runs(&session, 0).expect("list text runs");
    let added = runs
        .iter()
        .find(|r| r.text == "delete me")
        .expect("just-added run should be listed");
    let index = object_index(&added.object_id);

    session
        .commit(Box::new(DeleteObjectCommand::new(0, index)))
        .expect("commit object_delete");
    let after_delete = list_text_runs(&session, 0).expect("list text runs after delete");
    assert!(!after_delete.iter().any(|r| r.text == "delete me"));

    session.undo().expect("undo the delete");
    let after_undo = list_text_runs(&session, 0).expect("list text runs after undo");
    assert!(
        after_undo.iter().any(|r| r.text == "delete me"),
        "undoing object_delete should restore the run"
    );
}

/// The highlight rects (one per line run) of every case-sensitive occurrence of `text` on `page`,
/// found by the search v2 engine (`extract_page` -> `PageIndex` -> `Matcher`) — what a user
/// marking a search hit for redaction would send to `redact_apply`.
fn find_rects(session: &DocumentSession, page: u32, text: &str) -> Vec<Rect> {
    let query = SearchQuery {
        text: text.to_owned(),
        mode: SearchMode::Phrase,
        proximity: None,
        scope: SearchScope::All,
        case_sensitive: true,
        whole_word: false,
        ignore_diacritics: false,
        exclude_headers_footers: false,
    };
    let compiled = matcher::compile(&query).expect("compile query");
    let pdf_page = session
        .document()
        .pages()
        .get(page as i32)
        .expect("page exists");
    let index = PageIndex::from_raw(&extract::extract_page(&pdf_page, page));
    let mut matcher = Matcher::new(Arc::new(compiled));
    let mut found = matcher.push_page(Arc::new(index), &[]);
    found.extend(matcher.finish());
    found
        .into_iter()
        .flat_map(|f| f.hit.rects.into_iter().map(|r| r.rect))
        .collect()
}

/// DoD: "Redact a term across pages; byte-search proves zero trace in the saved file." Uses a
/// word ("booklet") that appears only in the page body — not in the document's Title/Author/
/// Producer/Creator metadata (all of which also contain "Rubrica") — so a naive byte-search
/// control isn't tripped up by unrelated metadata that redaction was never asked to touch.
fn redact_apply_leaves_no_trace_of_the_marked_text() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    let matches = find_rects(&session, 0, "booklet");
    assert!(
        !matches.is_empty(),
        "sanity: text.pdf's first page should contain \"booklet\" before redaction"
    );

    session
        .commit(Box::new(RedactCommand::new(0, matches)))
        .expect("commit redact_apply");
    session.save(false).expect("save");

    let redacted_bytes = std::fs::read(&work_path).expect("read saved file");
    assert!(
        !contains_decompressed(&redacted_bytes, b"booklet"),
        "the saved file must contain zero trace of the redacted term, even inside a \
         Flate-compressed stream"
    );
    // Sanity control for the assertion above: prove the search methodology actually finds
    // things (including inside a compressed stream — PDFium's own `save_to_bytes()` compresses
    // content streams by default, which is exactly why a *plain* byte scan alone would be
    // vacuous here) — a word from a *different* wrapped line than "booklet"'s (redaction
    // removes whole objects, and pdf-lib wraps several sentences of the source paragraph onto
    // "booklet"'s own line — see `engine::redact`'s module doc comment on that tradeoff — so a
    // control word from the same line would be gone too, for reasons unrelated to what this
    // test is actually checking) must still be found.
    assert!(
        contains_decompressed(&redacted_bytes, b"paragraphs"),
        "sanity: a word on a different line of the same page should still be found by the same \
         search this test just used to prove \"booklet\" is gone"
    );

    let reopened = DocumentSession::open(work_path.to_str().unwrap()).expect("reopen");
    let remaining = find_rects(&reopened, 0, "booklet");
    assert!(
        remaining.is_empty(),
        "PDFium's own text layer must no longer find the redacted term either"
    );

    assert_portable(&work_path, 3);
}

/// Interleaves R6 commands with R2's generic test-only commands (`RotatePageCommand`,
/// `InsertBlankPageCommand`) on the undo/redo stack, proving `SetTextCommand`/
/// `AddTextObjectCommand` play by the same rules as every other domain's commands.
fn mixed_undo_redo_across_domains_stays_consistent() {
    let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
    let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

    session
        .commit(Box::new(RotatePageCommand::new(0, 90)))
        .expect("commit rotate");
    session
        .commit(Box::new(AddTextObjectCommand::new(
            0,
            TextObjectSpec {
                rect: Rect {
                    x: 100.0,
                    y: 100.0,
                    width: 200.0,
                    height: 20.0,
                },
                text: "hello".to_string(),
                font_size: 12.0,
                color: "#000000".to_string(),
            },
        )))
        .expect("commit textobj_add");
    session
        .commit(Box::new(InsertBlankPageCommand::new(200.0, 200.0)))
        .expect("commit insert blank page");
    assert_eq!(session.info().page_count, 4);

    session.undo().expect("undo insert blank page");
    assert_eq!(session.info().page_count, 3);

    session.undo().expect("undo add text object");
    assert!(!list_text_runs(&session, 0)
        .unwrap()
        .iter()
        .any(|r| r.text == "hello"));

    session.undo().expect("undo rotate");
    let rotation = session
        .document()
        .pages()
        .get(0)
        .expect("page 0")
        .rotation()
        .expect("rotation");
    assert_eq!(
        rubrica_lib::engine::pdfium::rotation_to_degrees(rotation),
        0,
        "undoing the rotate should restore the original orientation"
    );

    session.redo().expect("redo rotate");
    session.redo().expect("redo add text object");
    session.redo().expect("redo insert blank page");
    assert_eq!(session.info().page_count, 4);
    assert!(list_text_runs(&session, 0)
        .unwrap()
        .iter()
        .any(|r| r.text == "hello"));
}
