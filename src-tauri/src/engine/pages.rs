//! Page reorder/rotate/delete/insert via PDFium page-object editing — R5's
//! module. Backs `commands::pages`; see `src-tauri/API.md` for the shared
//! `Command`/`DocumentSession` design this builds on and `agents/
//! CONTRACTS.md` §3 for the exact per-command semantics, mirrored here from
//! `src/ipc/mock/pages.ts`.
//!
//! ## No page-reorder primitive
//!
//! pdfium-render 0.9.3 has no ergonomic "move pages" API, and the raw
//! `FPDF_MovePages` FFI call, while present in the vendored bindings, is
//! unreachable from outside the crate: every raw `FPDF_DOCUMENT`/`FPDF_PAGE`
//! handle accessor (`PdfDocument::handle()`, `PdfPage::page_handle()`, ...)
//! is `pub(crate)`-gated, with no workaround. [`reorder_pages`] below is the
//! only technique the public API allows instead: copy every page, in the
//! desired order, into a scratch document, delete every page from the live
//! document, then copy them all back from the scratch copy. This is O(2N)
//! page copies for an N-page reorder (every page copied out, then every
//! page copied back in) — there is no faster path through the public API,
//! so this is a deliberate, documented cost, not an oversight.

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::document::DocumentSession;
use crate::engine::history::Command;
use crate::engine::pdfium::{degrees_to_rotation, rotation_to_degrees};
use crate::types::{PageRange, RubricaError};

/// `0..pages().len()` — the "structural change invalidates every page"
/// return value CONTRACTS / `mock/pages.ts`'s `allPageIndices` uses for
/// reorder/insert (and this module's own delete/insert reverts).
fn all_pages(doc: &PdfDocument<'static>) -> Vec<u32> {
    (0..doc.pages().len() as u32).collect()
}

/// `commands::pages` handlers use this to read the current page count
/// before validating an incoming request — see the `validate_*` helpers
/// below.
pub fn page_count(session: &DocumentSession) -> u32 {
    session.document().pages().len() as u32
}

fn internal(err: impl std::fmt::Display) -> RubricaError {
    RubricaError::internal(err.to_string())
}

/// Same classification `engine::document::DocumentSession::open` uses for
/// its own load failures — that function is private to its module, so this
/// is a deliberate small duplicate (see `API.md` §6), not a divergence.
fn map_source_open_error(err: PdfiumError) -> RubricaError {
    match err {
        PdfiumError::PdfiumLibraryInternalError(
            PdfiumInternalError::PasswordError | PdfiumInternalError::SecurityError,
        ) => RubricaError::encrypted("the source document is password-protected"),
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => {
            RubricaError::corrupt("the source document could not be parsed")
        }
        PdfiumError::IoError(io_err) => RubricaError::io(io_err.to_string()),
        other => RubricaError::corrupt(other.to_string()),
    }
}

// --- validation (shared by `commands::pages` and this module's own fixture tests) ---

/// `INVALID_ARG` per out-of-range page — matches `mock/pages.ts::pagesRotate`'s
/// per-page loop exactly (no dedup: a duplicate in-range index is not an error).
pub fn validate_pages_in_range(page_count: u32, pages: &[u32]) -> Result<(), RubricaError> {
    for &p in pages {
        if p >= page_count {
            return Err(RubricaError::invalid_arg(format!("page {p} out of range")));
        }
    }
    Ok(())
}

/// `order` must be exactly a permutation of `0..page_count` — matches
/// `mock/pages.ts::pagesReorder`'s `isPermutation` check (same length, all
/// in range, no duplicates).
pub fn validate_permutation(page_count: u32, order: &[u32]) -> Result<(), RubricaError> {
    let mut seen = std::collections::HashSet::with_capacity(order.len());
    let is_permutation =
        order.len() as u32 == page_count && order.iter().all(|&i| i < page_count && seen.insert(i));
    if is_permutation {
        Ok(())
    } else {
        Err(RubricaError::invalid_arg(
            "order must be a permutation of all page indices",
        ))
    }
}

/// Range-checks `pages` (not deduplicated, matching `mock/pages.ts::pagesDelete`'s
/// own per-page loop) and rejects a request that would delete every page in
/// the document, matching that same function's `"cannot delete every page
/// of a document"` error exactly.
pub fn validate_delete(page_count: u32, pages: &[u32]) -> Result<(), RubricaError> {
    validate_pages_in_range(page_count, pages)?;
    let mut unique: Vec<u32> = pages.to_vec();
    unique.sort_unstable();
    unique.dedup();
    if unique.len() as u32 >= page_count {
        return Err(RubricaError::invalid_arg(
            "cannot delete every page of a document",
        ));
    }
    Ok(())
}

// --- shared PDFium techniques -------------------------------------------------

/// Exports the pages at `indices` (in the given order) into a freshly
/// created scratch [`PdfDocument`], serialized to bytes — the stash format
/// [`PagesDeleteCommand`] and [`PagesInsertFromFileCommand`] use so their
/// `revert`/redo-`apply` never depend on anything from the live document or
/// (for insert-from-file) the original source file on disk still being
/// around later.
fn export_pages_to_bytes(
    doc: &PdfDocument<'static>,
    indices: &[u32],
) -> Result<Vec<u8>, RubricaError> {
    let pdfium = crate::engine::pdfium::shared();
    let mut scratch = pdfium.create_new_pdf().map_err(internal)?;
    for (dest, &src_index) in indices.iter().enumerate() {
        scratch
            .pages_mut()
            .copy_page_from_document(doc, src_index as PdfPageIndex, dest as PdfPageIndex)
            .map_err(internal)?;
    }
    scratch.save_to_bytes().map_err(internal)
}

/// The reorder technique described in the module doc comment, shared by
/// [`PagesReorderCommand::apply`] (with the requested `order`) and
/// [`PagesReorderCommand::revert`] (with `order`'s inverse permutation —
/// applying the inverse undoes the forward reorder exactly).
fn reorder_pages(doc: &mut PdfDocument<'static>, order: &[u32]) -> Result<(), RubricaError> {
    let pdfium = crate::engine::pdfium::shared();
    let mut scratch = pdfium.create_new_pdf().map_err(internal)?;
    for (dest, &src_index) in order.iter().enumerate() {
        scratch
            .pages_mut()
            .copy_page_from_document(doc, src_index as PdfPageIndex, dest as PdfPageIndex)
            .map_err(internal)?;
    }

    let old_count = doc.pages().len();
    for i in (0..old_count).rev() {
        doc.pages()
            .get(i)
            .map_err(internal)?
            .delete()
            .map_err(internal)?;
    }

    let new_count = scratch.pages().len();
    if new_count > 0 {
        doc.pages_mut()
            .copy_page_range_from_document(&scratch, 0..=(new_count - 1), 0)
            .map_err(internal)?;
    }
    Ok(())
}

fn invert_permutation(order: &[u32]) -> Vec<u32> {
    let mut inverse = vec![0u32; order.len()];
    for (i, &v) in order.iter().enumerate() {
        inverse[v as usize] = i as u32;
    }
    inverse
}

// --- pages_reorder -------------------------------------------------------------

/// Rebuilds the document's page order to match `order` (a permutation of
/// `0..pageCount`; `commands::pages::pages_reorder` validates this via
/// [`validate_permutation`] before ever constructing one of these). See the
/// module doc comment for why this needs a full copy-through-scratch-
/// document round trip rather than an in-place move.
#[derive(Debug, Serialize, Deserialize)]
pub struct PagesReorderCommand {
    order: Vec<u32>,
}

impl PagesReorderCommand {
    pub fn new(order: Vec<u32>) -> Self {
        Self { order }
    }
}

#[typetag::serde]
impl Command for PagesReorderCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        reorder_pages(doc, &self.order)?;
        Ok(all_pages(doc))
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let inverse = invert_permutation(&self.order);
        reorder_pages(doc, &inverse)?;
        Ok(all_pages(doc))
    }
}

// --- pages_rotate --------------------------------------------------------------

/// Rotates every page in `pages` additively by `delta_degrees` as one
/// undoable batch — CONTRACTS' `pages_rotate` takes a `Vec<u32>`, unlike
/// `engine::history::test_commands::RotatePageCommand`'s single page.
/// `previous[i]` is the absolute rotation (in degrees) `pages[i]` had
/// immediately before this command touched it *during this application* —
/// stashed index-for-index rather than deduplicated, so a `pages` list that
/// repeats an index still reverts correctly by unwinding in reverse order.
#[derive(Debug, Serialize, Deserialize)]
pub struct RotatePagesCommand {
    pages: Vec<u32>,
    delta_degrees: i32,
    #[serde(skip)]
    previous: Vec<i32>,
}

impl RotatePagesCommand {
    pub fn new(pages: Vec<u32>, delta_degrees: i32) -> Self {
        Self {
            pages,
            delta_degrees,
            previous: Vec::new(),
        }
    }

    fn set_rotation(
        doc: &mut PdfDocument<'static>,
        page_index: u32,
        degrees: i32,
    ) -> Result<(), RubricaError> {
        let mut page = doc
            .pages()
            .get(page_index as PdfPageIndex)
            .map_err(internal)?;
        page.set_rotation(degrees_to_rotation(degrees));
        Ok(())
    }
}

#[typetag::serde]
impl Command for RotatePagesCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        self.previous.clear();
        for &page_index in &self.pages {
            let before = {
                let page = doc
                    .pages()
                    .get(page_index as PdfPageIndex)
                    .map_err(internal)?;
                rotation_to_degrees(page.rotation().map_err(internal)?)
            };
            self.previous.push(before);
            Self::set_rotation(doc, page_index, before + self.delta_degrees)?;
        }
        Ok(self.pages.clone())
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        for (i, &page_index) in self.pages.iter().enumerate().rev() {
            let before = self.previous[i];
            Self::set_rotation(doc, page_index, before)?;
        }
        self.previous.clear();
        Ok(self.pages.clone())
    }
}

// --- pages_delete ---------------------------------------------------------------

/// Deletes `pages` (deduplicated) in descending index order so each
/// deletion never shifts the index of a page not yet processed.
/// `commands::pages::pages_delete` validates `pages` via [`validate_delete`]
/// (in range, and not covering every page) before ever constructing one of
/// these. Each deleted page's full content is exported to its own small
/// in-memory scratch document (see [`export_pages_to_bytes`]) *before* it
/// is deleted, so `revert()` can reinsert exact copies without needing
/// anything else from the live document.
#[derive(Debug, Serialize, Deserialize)]
pub struct PagesDeleteCommand {
    pages: Vec<u32>,
    /// `(original_index, single-page PDF bytes)`, populated in descending
    /// `original_index` order during `apply()` (deletion order). `revert()`
    /// walks this in reverse (ascending original index) so pages land back
    /// at the same absolute positions they started at.
    #[serde(skip)]
    stashed: Vec<(u32, Vec<u8>)>,
}

impl PagesDeleteCommand {
    pub fn new(pages: Vec<u32>) -> Self {
        Self {
            pages,
            stashed: Vec::new(),
        }
    }
}

#[typetag::serde]
impl Command for PagesDeleteCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut unique: Vec<u32> = self.pages.clone();
        unique.sort_unstable();
        unique.dedup();
        unique.reverse();

        self.stashed.clear();
        for index in unique {
            let bytes = export_pages_to_bytes(doc, &[index])?;
            doc.pages()
                .get(index as PdfPageIndex)
                .map_err(internal)?
                .delete()
                .map_err(internal)?;
            self.stashed.push((index, bytes));
        }
        Ok(all_pages(doc))
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let pdfium = crate::engine::pdfium::shared();
        let stashed = std::mem::take(&mut self.stashed);
        for (index, bytes) in stashed.into_iter().rev() {
            let scratch = pdfium
                .load_pdf_from_byte_vec(bytes, None)
                .map_err(internal)?;
            doc.pages_mut()
                .copy_page_from_document(&scratch, 0, index as PdfPageIndex)
                .map_err(internal)?;
        }
        Ok(all_pages(doc))
    }
}

// --- pages_insert_blank ----------------------------------------------------------

/// Inserts one blank page of `width`×`height` PDF points at index `at`.
/// `commands::pages::pages_insert_blank` clamps `at` into `[0, pageCount]`
/// and rejects non-positive dimensions before constructing one of these.
#[derive(Debug, Serialize, Deserialize)]
pub struct InsertBlankPageAtCommand {
    at: u32,
    width: f32,
    height: f32,
}

impl InsertBlankPageAtCommand {
    pub fn new(at: u32, width: f32, height: f32) -> Self {
        Self { at, width, height }
    }
}

#[typetag::serde]
impl Command for InsertBlankPageAtCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        doc.pages_mut()
            .create_page_at_index(
                PdfPagePaperSize::Custom(PdfPoints::new(self.width), PdfPoints::new(self.height)),
                self.at as PdfPageIndex,
            )
            .map_err(internal)?;
        Ok(all_pages(doc))
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        doc.pages()
            .get(self.at as PdfPageIndex)
            .map_err(internal)?
            .delete()
            .map_err(internal)?;
        Ok(all_pages(doc))
    }
}

// --- pages_insert_from_file -------------------------------------------------------

/// Copies a page range from a source file into this document, inserting at
/// index `at`. `commands::pages::pages_insert_from_file` clamps `at` before
/// constructing one of these, but the actual import always happens inside
/// `apply()` — so a journal replay, which reconstructs this command from
/// JSON and calls `apply()` fresh, re-imports without any handler help.
///
/// The *first* `apply()` (an initial commit, or a journal replay) reads
/// `path` fresh and, right after importing, exports the newly-inserted
/// pages' content into `stashed_bytes` (see [`export_pages_to_bytes`]).
/// Every subsequent `apply()` — i.e. a redo, which only ever happens after
/// an intervening `revert()` — reinserts from that stash instead of
/// reopening `path`, so redo never depends on the original source file
/// still existing/unchanged at that path.
#[derive(Debug, Serialize, Deserialize)]
pub struct PagesInsertFromFileCommand {
    at: u32,
    path: String,
    range: Option<PageRange>,
    #[serde(skip)]
    inserted_count: u32,
    #[serde(skip)]
    stashed_bytes: Option<Vec<u8>>,
}

impl PagesInsertFromFileCommand {
    pub fn new(at: u32, path: String, range: Option<PageRange>) -> Self {
        Self {
            at,
            path,
            range,
            inserted_count: 0,
            stashed_bytes: None,
        }
    }

    fn import_from_stash(
        &mut self,
        doc: &mut PdfDocument<'static>,
        bytes: Vec<u8>,
    ) -> Result<(), RubricaError> {
        let pdfium = crate::engine::pdfium::shared();
        let scratch = pdfium
            .load_pdf_from_byte_vec(bytes, None)
            .map_err(internal)?;
        let count = scratch.pages().len();
        if count > 0 {
            doc.pages_mut()
                .copy_page_range_from_document(&scratch, 0..=(count - 1), self.at as PdfPageIndex)
                .map_err(internal)?;
        }
        self.inserted_count = count as u32;
        Ok(())
    }

    fn import_from_source_file(
        &mut self,
        doc: &mut PdfDocument<'static>,
    ) -> Result<(), RubricaError> {
        let pdfium = crate::engine::pdfium::shared();
        let source = pdfium
            .load_pdf_from_file(&self.path, None)
            .map_err(map_source_open_error)?;
        let source_count = source.pages().len() as u32;
        if source_count == 0 {
            return Err(RubricaError::invalid_arg("source document has no pages"));
        }
        let (start, end) = match &self.range {
            Some(r) => (r.start, r.end),
            None => (0, source_count - 1),
        };
        if start > end || end >= source_count {
            return Err(RubricaError::invalid_arg(format!(
                "page range {start}-{end} is out of bounds for a {source_count}-page source document"
            )));
        }
        doc.pages_mut()
            .copy_page_range_from_document(
                &source,
                start as PdfPageIndex..=end as PdfPageIndex,
                self.at as PdfPageIndex,
            )
            .map_err(internal)?;
        self.inserted_count = end - start + 1;

        let indices: Vec<u32> = (self.at..self.at + self.inserted_count).collect();
        self.stashed_bytes = Some(export_pages_to_bytes(doc, &indices)?);
        Ok(())
    }
}

#[typetag::serde]
impl Command for PagesInsertFromFileCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        match self.stashed_bytes.clone() {
            Some(bytes) => self.import_from_stash(doc, bytes)?,
            None => self.import_from_source_file(doc)?,
        }
        Ok(all_pages(doc))
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        for _ in 0..self.inserted_count {
            doc.pages()
                .get(self.at as PdfPageIndex)
                .map_err(internal)?
                .delete()
                .map_err(internal)?;
        }
        Ok(all_pages(doc))
    }
}

// --- fixture tests -------------------------------------------------------------
//
// Deliberately **not** `#[cfg(test)]`-gated — same reasoning as
// `engine::history::test_commands` (see that module's doc comment and
// `API.md`): `tests/engine_fixtures.rs` is a separate integration-test
// binary that links this crate as an ordinary (non-`#[cfg(test)]`)
// dependency, so anything gated on the *library's own* test build compiled
// would not exist for it to call. The orchestrator wires [`run_all`] into
// one combined `#[test]` alongside the annotations/forms modules'
// equivalents.
//
// Every sub-test below is a plain function; [`run_all`] calls them all
// itself, sequentially, on whichever single thread its caller runs on —
// see `tests/engine_fixtures.rs`'s own module doc comment for why more than
// one OS thread touching the vendored PDFium binary, even one call at a
// time, reliably segfaults.
pub mod fixture_tests {
    use std::path::{Path, PathBuf};
    use std::sync::Once;

    use pdfium_render::prelude::*;
    use serde::{Deserialize, Serialize};

    use super::{
        internal, validate_delete, validate_permutation, InsertBlankPageAtCommand,
        PagesDeleteCommand, PagesInsertFromFileCommand, PagesReorderCommand, RotatePagesCommand,
    };
    use crate::engine::document::DocumentSession;
    use crate::engine::history::Command;
    use crate::engine::text;
    use crate::types::{PageRange, RubricaError, RubricaErrorCode};

    static INIT: Once = Once::new();

    /// Points `RUBRICA_JOURNAL_DIR` at a scratch directory, matching
    /// `tests/engine_fixtures.rs`'s own `init_test_journal_dir` — a no-op if
    /// that (or an equivalent sibling module's) init already ran first in
    /// this process, since `RUBRICA_JOURNAL_DIR` is then already set to some
    /// scratch directory.
    fn init_test_journal_dir() {
        INIT.call_once(|| {
            if std::env::var("RUBRICA_JOURNAL_DIR").is_ok() {
                return;
            }
            let dir = std::env::temp_dir()
                .join(format!("rubrica-pages-test-journal-{}", std::process::id()));
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

    /// The full portability gate for a file this test suite wrote: re-opens
    /// `path` through the shared Pdfium handle and shells out to
    /// `scripts/verify-pdf.mjs` for the pdf-lib half — mirrors
    /// `tests/engine_fixtures.rs::assert_portable` exactly (duplicated here
    /// rather than shared, since that file's helpers aren't visible to this
    /// library crate).
    fn assert_portable(path: &Path, expected_pages: u32) {
        let reopened = crate::engine::pdfium::shared()
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

    fn page_text(session: &DocumentSession, page: u32) -> String {
        let layout = text::page_layout(session, page).expect("page_layout should succeed");
        text::extract_range(session, page, 0, layout.len() as u32)
            .expect("extract_range should succeed")
    }

    /// A test-only `Command` that adds a single highlight annotation to a
    /// page, used only to verify that annotations survive the
    /// copy-through-scratch-document reorder technique — not part of the
    /// `annotations` domain (owned by a different wave-2 module) and never
    /// exercised outside this test module.
    #[derive(Debug, Serialize, Deserialize)]
    struct AddTestHighlightAnnotationCommand {
        page: u32,
    }

    #[typetag::serde]
    impl Command for AddTestHighlightAnnotationCommand {
        fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
            let mut page = doc
                .pages()
                .get(self.page as PdfPageIndex)
                .map_err(internal)?;
            let mut annotation = page
                .annotations_mut()
                .create_highlight_annotation()
                .map_err(internal)?;
            annotation
                .set_bounds(PdfRect::new(
                    PdfPoints::new(10.0),
                    PdfPoints::new(10.0),
                    PdfPoints::new(60.0),
                    PdfPoints::new(120.0),
                ))
                .map_err(internal)?;
            Ok(vec![self.page])
        }

        fn revert(&mut self, _doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
            Err(RubricaError::internal(
                "AddTestHighlightAnnotationCommand is test-only and never undone",
            ))
        }
    }

    /// The single entry point — see the module doc comment for why every
    /// sub-test below is a plain function called from here rather than each
    /// being its own `#[test]`.
    pub fn run_all() {
        init_test_journal_dir();

        reorders_pages_and_persists_the_new_order();
        undo_redo_through_a_reorder();
        rotates_pages_additively_and_persists();
        deletes_a_page_and_persists_remaining_content();
        undo_redo_through_a_delete();
        rejects_deleting_every_page();
        inserts_a_blank_page_at_a_middle_index();
        inserts_a_page_range_from_another_fixture();
        reorder_preserves_annotations();
        page_ops_do_not_disturb_form_fields();
    }

    fn reorders_pages_and_persists_the_new_order() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let path_str = work_path.to_str().unwrap().to_string();

        let mut session = DocumentSession::open(&path_str).expect("open text.pdf copy");
        assert_eq!(session.info().page_count, 3);
        let original: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();

        let order = vec![2u32, 0, 1];
        validate_permutation(3, &order).expect("2,0,1 is a valid permutation of 0..3");
        session
            .commit(Box::new(PagesReorderCommand::new(order.clone())))
            .expect("reorder commit should succeed");
        assert_eq!(session.info().page_count, 3);

        for (new_index, &old_index) in order.iter().enumerate() {
            assert_eq!(
                page_text(&session, new_index as u32),
                original[old_index as usize],
                "new page {new_index} should hold old page {old_index}'s content"
            );
        }

        session.save(false).expect("save reordered document");
        let reopened = DocumentSession::open(&path_str).expect("reopen after save");
        for (new_index, &old_index) in order.iter().enumerate() {
            assert_eq!(
                page_text(&reopened, new_index as u32),
                original[old_index as usize],
                "reorder must persist across a fresh reopen"
            );
        }
        assert_portable(&work_path, 3);
    }

    fn undo_redo_through_a_reorder() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");
        let original: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();

        session
            .commit(Box::new(PagesReorderCommand::new(vec![2, 0, 1])))
            .expect("reorder commit");
        let reordered: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();
        assert_ne!(
            reordered, original,
            "sanity: the reorder actually changed page order"
        );

        session
            .undo()
            .expect("undo")
            .expect("there was a reorder to undo");
        let after_undo: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();
        assert_eq!(
            after_undo, original,
            "undo should restore the original page order"
        );

        session
            .redo()
            .expect("redo")
            .expect("there was a reorder to redo");
        let after_redo: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();
        assert_eq!(
            after_redo, reordered,
            "redo should reapply the exact same reorder"
        );
    }

    fn rotates_pages_additively_and_persists() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let path_str = work_path.to_str().unwrap().to_string();
        let mut session = DocumentSession::open(&path_str).expect("open");

        validate_permutation(3, &[0, 1, 2]).expect("no-op sanity check on validate_permutation");

        session
            .commit(Box::new(RotatePagesCommand::new(vec![0, 2], 90)))
            .expect("first rotate commit");
        assert_eq!(rotation_of(&session, 0), 90);
        assert_eq!(rotation_of(&session, 1), 0, "page 1 was not in the batch");
        assert_eq!(rotation_of(&session, 2), 90);

        session
            .commit(Box::new(RotatePagesCommand::new(vec![0, 2], 90)))
            .expect("second rotate commit accumulates additively");
        assert_eq!(rotation_of(&session, 0), 180);
        assert_eq!(rotation_of(&session, 2), 180);

        session
            .undo()
            .expect("undo")
            .expect("there was a rotate to undo");
        assert_eq!(
            rotation_of(&session, 0),
            90,
            "undo should revert only the last rotate"
        );
        session
            .redo()
            .expect("redo")
            .expect("there was a rotate to redo");
        assert_eq!(rotation_of(&session, 0), 180);

        session.save(false).expect("save rotated document");
        let reopened = DocumentSession::open(&path_str).expect("reopen after save");
        assert_eq!(
            rotation_of(&reopened, 0),
            180,
            "rotation must persist across a fresh reopen"
        );
        assert_eq!(rotation_of(&reopened, 1), 0);
        assert_portable(&work_path, 3);
    }

    fn rotation_of(session: &DocumentSession, page: u32) -> i32 {
        let pdf_page = session
            .document()
            .pages()
            .get(page as PdfPageIndex)
            .expect("page should exist");
        crate::engine::pdfium::rotation_to_degrees(
            pdf_page.rotation().expect("rotation should be readable"),
        )
    }

    fn deletes_a_page_and_persists_remaining_content() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let path_str = work_path.to_str().unwrap().to_string();
        let mut session = DocumentSession::open(&path_str).expect("open");
        let original: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();

        validate_delete(3, &[1]).expect("deleting the middle page of 3 is valid");
        session
            .commit(Box::new(PagesDeleteCommand::new(vec![1])))
            .expect("delete commit should succeed");
        assert_eq!(session.info().page_count, 2);
        assert_eq!(page_text(&session, 0), original[0]);
        assert_eq!(
            page_text(&session, 1),
            original[2],
            "remaining page 2 should shift down to index 1"
        );

        session.save(false).expect("save after delete");
        let reopened = DocumentSession::open(&path_str).expect("reopen after save");
        assert_eq!(reopened.info().page_count, 2);
        assert_eq!(page_text(&reopened, 0), original[0]);
        assert_eq!(page_text(&reopened, 1), original[2]);
        assert_portable(&work_path, 2);
    }

    fn undo_redo_through_a_delete() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");
        let original: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();

        session
            .commit(Box::new(PagesDeleteCommand::new(vec![1])))
            .expect("delete commit");
        assert_eq!(session.info().page_count, 2);

        session
            .undo()
            .expect("undo")
            .expect("there was a delete to undo");
        assert_eq!(
            session.info().page_count,
            3,
            "undo should restore the deleted page"
        );
        let after_undo: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();
        assert_eq!(
            after_undo, original,
            "undo should restore the exact original content"
        );

        session
            .redo()
            .expect("redo")
            .expect("there was a delete to redo");
        assert_eq!(
            session.info().page_count,
            2,
            "redo should reapply the delete"
        );
        assert_eq!(page_text(&session, 0), original[0]);
        assert_eq!(page_text(&session, 1), original[2]);
    }

    fn rejects_deleting_every_page() {
        match validate_delete(3, &[0, 1, 2]) {
            Err(err) => assert_eq!(err.code, RubricaErrorCode::InvalidArg),
            Ok(()) => panic!("deleting every page of a 3-page document must be rejected"),
        }
        // Deduplication matters: three requests naming only two distinct
        // pages out of three must NOT be treated as "every page".
        validate_delete(3, &[0, 1, 0])
            .expect("two distinct pages out of three is not \"every page\"");
    }

    fn inserts_a_blank_page_at_a_middle_index() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let path_str = work_path.to_str().unwrap().to_string();
        let mut session = DocumentSession::open(&path_str).expect("open");
        let original: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();

        session
            .commit(Box::new(InsertBlankPageAtCommand::new(1, 200.0, 300.0)))
            .expect("insert-blank commit should succeed");
        assert_eq!(session.info().page_count, 4);
        assert_eq!(page_text(&session, 0), original[0]);
        assert_eq!(
            page_text(&session, 1),
            "",
            "the newly inserted page has no text"
        );
        assert_eq!(
            page_text(&session, 2),
            original[1],
            "old page 1 should shift down to index 2"
        );
        assert_eq!(page_text(&session, 3), original[2]);

        let inserted = session
            .document()
            .pages()
            .get(1)
            .expect("the inserted page should exist");
        assert_eq!(inserted.width().value as f64, 200.0);
        assert_eq!(inserted.height().value as f64, 300.0);
        drop(inserted);

        session.save(false).expect("save after insert-blank");
        let reopened = DocumentSession::open(&path_str).expect("reopen after save");
        assert_eq!(reopened.info().page_count, 4);
        assert_eq!(reopened.info().pages[1].width, 200.0);
        assert_eq!(reopened.info().pages[1].height, 300.0);
        assert_portable(&work_path, 4);
    }

    fn inserts_a_page_range_from_another_fixture() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let path_str = work_path.to_str().unwrap().to_string();
        let unicode_path = fixture("unicode.pdf").to_str().unwrap().to_string();

        let mut session = DocumentSession::open(&path_str).expect("open");
        let original: Vec<String> = (0..3).map(|p| page_text(&session, p)).collect();

        // unicode.pdf is a single page (fixtures/README.md); import it at
        // index 1 with an explicit `range` covering that one page.
        session
            .commit(Box::new(PagesInsertFromFileCommand::new(
                1,
                unicode_path.clone(),
                Some(PageRange { start: 0, end: 0 }),
            )))
            .expect("insert-from-file commit should succeed");
        assert_eq!(session.info().page_count, 4);
        assert_eq!(page_text(&session, 0), original[0]);
        let imported_text = page_text(&session, 1);
        assert!(
            imported_text.chars().any(|c| "áàâãçéêíóôõú".contains(c)),
            "the imported page should carry unicode.pdf's PT-PT accented text, got: {imported_text}"
        );
        assert_eq!(page_text(&session, 2), original[1]);
        assert_eq!(page_text(&session, 3), original[2]);

        session.save(false).expect("save after insert-from-file");
        let reopened = DocumentSession::open(&path_str).expect("reopen after save");
        assert_eq!(reopened.info().page_count, 4);
        assert_eq!(
            page_text(&reopened, 1),
            imported_text,
            "import must persist across a fresh reopen"
        );
        assert_portable(&work_path, 4);

        // Undo must remove exactly the imported page; redo must reinsert
        // without needing `unicode_path` again (it reinserts from the bytes
        // stashed at the first apply()) — exercised on a fresh second copy
        // so it doesn't disturb the save/reopen assertions above.
        let (_dir2, work_path2) = copy_fixture_to_scratch("text.pdf");
        let mut session =
            DocumentSession::open(work_path2.to_str().unwrap()).expect("open second copy");
        session
            .commit(Box::new(PagesInsertFromFileCommand::new(
                1,
                unicode_path,
                Some(PageRange { start: 0, end: 0 }),
            )))
            .expect("insert-from-file commit (second copy)");
        assert_eq!(session.info().page_count, 4);

        session
            .undo()
            .expect("undo")
            .expect("there was an insert to undo");
        assert_eq!(
            session.info().page_count,
            3,
            "undo should remove exactly the imported page"
        );
        assert_eq!(page_text(&session, 0), original[0]);
        assert_eq!(page_text(&session, 1), original[1]);

        session
            .redo()
            .expect("redo")
            .expect("there was an insert to redo");
        assert_eq!(
            session.info().page_count,
            4,
            "redo should reinsert without needing the source file again"
        );
        assert!(page_text(&session, 1)
            .chars()
            .any(|c| "áàâãçéêíóôõú".contains(c)));
    }

    fn reorder_preserves_annotations() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

        session
            .commit(Box::new(AddTestHighlightAnnotationCommand { page: 0 }))
            .expect("adding a highlight annotation should succeed");
        assert_eq!(annotation_count(&session, 0), 1);
        assert_eq!(annotation_count(&session, 1), 0);
        assert_eq!(annotation_count(&session, 2), 0);

        // order = [2, 0, 1]: new position 1 receives old page 0 — the
        // annotated one.
        session
            .commit(Box::new(PagesReorderCommand::new(vec![2, 0, 1])))
            .expect("reorder commit should succeed");
        assert_eq!(
            annotation_count(&session, 1),
            1,
            "the annotated page's own annotation must survive the copy-through-scratch-document reorder"
        );
        assert_eq!(annotation_count(&session, 0), 0);
        assert_eq!(annotation_count(&session, 2), 0);

        // And through a full save/reload round trip, not just in-memory.
        session.save(false).expect("save");
        let reopened =
            DocumentSession::open(work_path.to_str().unwrap()).expect("reopen after save");
        assert_eq!(
            annotation_count(&reopened, 1),
            1,
            "the annotation must still be there after a fresh reopen from disk"
        );
    }

    fn annotation_count(session: &DocumentSession, page: u32) -> usize {
        session
            .document()
            .pages()
            .get(page as PdfPageIndex)
            .expect("page should exist")
            .annotations()
            .len()
    }

    /// Sanity check (not a full forms test — that domain belongs to a
    /// different wave-2 module): page-structure operations must not corrupt
    /// `form.pdf`'s AcroForm fields. `form.pdf` is a single page
    /// (fixtures/README.md), so the only page ops that make sense against
    /// it without violating "cannot delete every page" or reordering a
    /// single-page no-op are insert-blank and rotate — both exercised here.
    fn page_ops_do_not_disturb_form_fields() {
        let (_dir, work_path) = copy_fixture_to_scratch("form.pdf");
        let mut session =
            DocumentSession::open(work_path.to_str().unwrap()).expect("open form.pdf copy");
        assert!(session.info().has_form);

        let fields_before = field_names(&session);
        assert!(
            !fields_before.is_empty(),
            "form.pdf should report at least one field"
        );

        session
            .commit(Box::new(InsertBlankPageAtCommand::new(1, 200.0, 200.0)))
            .expect("insert-blank commit should succeed");
        session
            .commit(Box::new(RotatePagesCommand::new(vec![0], 90)))
            .expect("rotate commit should succeed");
        assert_eq!(session.info().page_count, 2);

        let fields_after = field_names(&session);
        assert_eq!(
            fields_before, fields_after,
            "inserting a page and rotating the original form page must not disturb its fields"
        );

        session.save(false).expect("save");
        let reopened =
            DocumentSession::open(work_path.to_str().unwrap()).expect("reopen after save");
        assert!(
            reopened.info().has_form,
            "the AcroForm itself must survive the round trip"
        );
        assert_eq!(
            field_names(&reopened),
            fields_before,
            "fields must still be there after a fresh reopen from disk"
        );
    }

    fn field_names(session: &DocumentSession) -> std::collections::BTreeSet<String> {
        let doc = session.document();
        doc.form()
            .expect("form.pdf should report a form")
            .field_values(doc.pages())
            .into_keys()
            .collect()
    }
}
