//! Search-engine guarantees of the original phase-1 suite (agents/SEARCH-ORCHESTRATION.md §1,
//! bugs B2, B10, B11, `textless`, cancellation, duplicate ids), ported to the search v2 pipeline
//! (`engine::search::pipeline::{prepare, run}`): one occurrence = one hit even when it wraps,
//! `charStart/charLen` and rects consistent with `text_page_layout` on every page kind, progress,
//! `done`, `textless`, cancellation and the client-id registry. The pipeline-specific behaviour
//! (proximity, scope, outline, furniture, cache) is in `search_v2_pipeline.rs`.
//!
//! Everything PDFium runs on the `SessionStore` owner thread, exactly like production
//! (`commands/text.rs`): documents are opened with `with_store`, and the pipeline hops through
//! `with_session`. The test thread itself never touches PDFium. As in
//! `engine_fixtures.rs` (see its module doc) all sub-tests are plain functions called in sequence
//! from the one `#[test]`, sharing one `SessionStore`, so the vendored PDFium build only ever
//! sees a single thread identity.
//!
//! The text/geometry fixtures are synthesized here (tiny hand-written PDFs with a standard-14
//! Helvetica font) rather than checked in: a line wrap inside the phrase, `/Rotate 90`, and a
//! CropBox that differs from the MediaBox are each a few lines of PDF source, and keeping them
//! next to the assertions makes the intent obvious.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

use pdfium_render::prelude::*;
use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::search::pipeline::{self, PROGRESS_EVERY_PAGES};
use rubrica_lib::engine::text::{self, SearchRegistry};
use rubrica_lib::types::{
    CharBox, DocId, Rect, RubricaErrorCode, SearchBatch, SearchHit, SearchMode, SearchQuery,
    SearchScope,
};

static INIT: Once = Once::new();

fn init_journal_dir() {
    INIT.call_once(|| {
        let dir =
            std::env::temp_dir().join(format!("rubrica-search-journal-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch journal dir");
        std::env::set_var("RUBRICA_JOURNAL_DIR", &dir);
    });
}

fn fixture(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "..", "fixtures", name]
        .iter()
        .collect()
}

// --- synthesized PDFs ----------------------------------------------------------------------

/// A one-page PDF: Helvetica 12pt, `content` as the page's content stream, `page_extra` spliced
/// into the page dictionary (`/Rotate 90`, `/CropBox [...]`), a MediaBox of `media`.
fn build_pdf(media: [i32; 4], page_extra: &str, content: &str) -> Vec<u8> {
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_string(),
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [{} {} {} {}] {page_extra} \
             /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
            media[0], media[1], media[2], media[3]
        ),
        format!(
            "<< /Length {} >>\nstream\n{content}\nendstream",
            content.len()
        ),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
            .to_string(),
    ];
    let mut out = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (i, body) in objects.iter().enumerate() {
        offsets.push(out.len());
        out.extend_from_slice(format!("{} 0 obj\n{body}\nendobj\n", i + 1).as_bytes());
    }
    let xref_at = out.len();
    out.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for off in offsets {
        out.extend_from_slice(format!("{off:010} 00000 n \n").as_bytes());
    }
    out.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        )
        .as_bytes(),
    );
    out
}

/// "lazy dog" occurs twice: once wrapped across the two lines, once inside line 2.
const WRAPPED_CONTENT: &str = "BT /F1 12 Tf 72 700 Td (alpha beta gamma delta lazy) Tj \
                               0 -14 Td (dog epsilon zeta lazy dog eta) Tj ET";

fn write_synth_pdfs(dir: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let wrapped = dir.join("wrapped.pdf");
    std::fs::write(&wrapped, build_pdf([0, 0, 612, 792], "", WRAPPED_CONTENT)).unwrap();
    let rotated = dir.join("rotated.pdf");
    std::fs::write(
        &rotated,
        build_pdf([0, 0, 612, 792], "/Rotate 90", WRAPPED_CONTENT),
    )
    .unwrap();
    // CropBox strictly inside the MediaBox, text inside the crop.
    let cropped = dir.join("cropped.pdf");
    std::fs::write(
        &cropped,
        build_pdf(
            [0, 0, 612, 792],
            "/CropBox [60 600 360 760]",
            WRAPPED_CONTENT,
        ),
    )
    .unwrap();
    (wrapped, rotated, cropped)
}

// --- harness -------------------------------------------------------------------------------

fn open(store: &SessionStore, path: &Path) -> DocId {
    let path = path.to_str().unwrap().to_owned();
    store
        .with_store(move |sessions| {
            let session = DocumentSession::open(&path).expect("open fixture");
            let id = session.id().clone();
            sessions.insert(id.clone(), session);
            id
        })
        .expect("owner thread alive")
}

/// A phrase search over the whole document with accents significant (like the PDFium search the
/// phase-1 tests were written against) and no header/footer exclusion.
fn opts(case_sensitive: bool, whole_word: bool) -> Opts {
    Opts {
        case_sensitive,
        whole_word,
    }
}

#[derive(Clone, Copy)]
struct Opts {
    case_sensitive: bool,
    whole_word: bool,
}

fn query_of(text: &str, options: Opts) -> SearchQuery {
    SearchQuery {
        text: text.to_owned(),
        mode: SearchMode::Phrase,
        proximity: None,
        scope: SearchScope::All,
        case_sensitive: options.case_sensitive,
        whole_word: options.whole_word,
        ignore_diacritics: false,
        exclude_headers_footers: false,
    }
}

/// Drives the pipeline exactly the way `commands/text.rs::run_search` does and returns every
/// emitted batch. `on_batch` runs after each emitted batch (to cancel mid-search).
fn run_with(
    store: &SessionStore,
    doc: &str,
    query: &str,
    options: &Opts,
    cancelled: &AtomicBool,
    mut on_batch: impl FnMut(&SearchBatch),
) -> Vec<SearchBatch> {
    let plan = pipeline::prepare(store, doc, &query_of(query, *options)).expect("valid query");
    let mut batches = Vec::new();
    pipeline::run(store, doc, "test-search", plan, cancelled, |batch| {
        on_batch(&batch);
        batches.push(batch);
    });
    batches
}

fn run(store: &SessionStore, doc: &str, query: &str, options: &Opts) -> Vec<SearchBatch> {
    run_with(store, doc, query, options, &AtomicBool::new(false), |_| {})
}

fn all_hits(batches: &[SearchBatch]) -> Vec<(u32, &SearchHit)> {
    batches
        .iter()
        .flat_map(|b| &b.matches)
        .flat_map(|m| m.hits.iter().map(move |h| (m.page, h)))
        .collect()
}

fn page_text(store: &SessionStore, doc: &str, page: u32) -> String {
    store
        .with_session(doc, move |s| {
            text::extract_range(s, page, 0, u32::MAX).unwrap()
        })
        .unwrap()
}

fn layout(store: &SessionStore, doc: &str, page: u32) -> Vec<CharBox> {
    store
        .with_session(doc, move |s| text::page_layout(s, page).unwrap())
        .unwrap()
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The v2 index stores char boxes quantized (outwards) on a per-page grid, so a hit rect may be up
/// to ~0.012 pt larger than the exact union of `page_layout`'s boxes (`PageIndex`, S3 report).
fn approx(a: f64, b: f64) -> bool {
    (a - b).abs() < 0.05
}

fn rect_approx_eq(a: &Rect, b: &Rect) -> bool {
    approx(a.x, b.x) && approx(a.y, b.y) && approx(a.width, b.width) && approx(a.height, b.height)
}

fn center_inside(inner: &Rect, outer: &Rect) -> bool {
    let (cx, cy) = (inner.x + inner.width / 2.0, inner.y + inner.height / 2.0);
    cx >= outer.x - 0.01
        && cx <= outer.x + outer.width + 0.01
        && cy >= outer.y - 0.01
        && cy <= outer.y + outer.height + 0.01
}

// --- B2: one occurrence = one hit ------------------------------------------------------------

fn b2_wrapped_occurrence_is_one_hit_with_one_rect_per_line(store: &SessionStore, wrapped: &Path) {
    let doc = open(store, wrapped);
    let batches = run(store, &doc, "lazy dog", &opts(false, false));
    let hits = all_hits(&batches);

    assert_eq!(
        hits.len(),
        2,
        "\"lazy dog\" occurs twice (once wrapped across two lines); got hits: {hits:#?}"
    );
    assert_eq!(
        hits[0].1.rects.len(),
        2,
        "the wrapped occurrence is ONE hit with one rect per line segment"
    );
    assert_eq!(
        hits[1].1.rects.len(),
        1,
        "the unwrapped occurrence has one rect"
    );

    for (_, hit) in &hits {
        assert!(hit.char_len > 0, "char_len must be filled in");
        assert_eq!(hit.context.matched, "lazy dog");
        let range_text = page_text_range(store, &doc, 0, hit.char_start, hit.char_len);
        assert_eq!(collapse(&range_text).to_lowercase(), "lazy dog");
    }
    assert!(hits[0].1.char_start < hits[1].1.char_start);
    assert!(
        hits[0].1.char_start + hits[0].1.char_len <= hits[1].1.char_start,
        "occurrences must not overlap"
    );
    // The wrapped hit's context: text before "lazy", text after "dog" (which is on the next line).
    assert_eq!(hits[0].1.context.before, "alpha beta gamma delta ");
    assert_eq!(hits[0].1.context.after, " epsilon zeta lazy dog eta");
    assert_eq!(
        hits[1].1.context.before,
        "alpha beta gamma delta lazy dog epsilon zeta "
    );
    assert_eq!(hits[1].1.context.after, " eta");
}

fn page_text_range(store: &SessionStore, doc: &str, page: u32, start: u32, len: u32) -> String {
    store
        .with_session(doc, move |s| {
            text::extract_range(s, page, start, start + len).unwrap()
        })
        .unwrap()
}

/// Real document, independent count: for a query that cannot wrap (no whitespace), the number of
/// hits must equal a plain substring count over the page's extracted text.
fn b2_hit_count_matches_an_independent_substring_count_on_text_pdf(store: &SessionStore) {
    let doc = open(store, &fixture("text.pdf"));
    let page_count = store.with_session(&doc, |s| text::page_count(s)).unwrap();
    for query in ["the", "booklet", "a"] {
        let batches = run(store, &doc, query, &opts(false, false));
        let hits = all_hits(&batches);
        let mut expected = 0usize;
        for page in 0..page_count {
            expected += page_text(store, &doc, page)
                .to_lowercase()
                .matches(query)
                .count();
        }
        assert!(expected > 0, "sanity: \"{query}\" appears in text.pdf");
        assert_eq!(hits.len(), expected, "hit count for \"{query}\"");
        for (page, hit) in &hits {
            assert!(!hit.rects.is_empty());
            assert_eq!(
                page_text_range(store, &doc, *page, hit.char_start, hit.char_len).to_lowercase(),
                query,
                "[char_start, +char_len) must extract exactly the matched text"
            );
            assert_eq!(hit.context.matched.to_lowercase(), query);
        }
    }
}

/// Wrapped occurrences inside real, justified prose: every hit's range extracts the query once
/// whitespace is collapsed, and no hit has a rect per word-run duplicated as its own hit.
fn b2_multiword_queries_on_text_pdf_group_per_occurrence(store: &SessionStore) {
    let doc = open(store, &fixture("text.pdf"));
    let page_count = store.with_session(&doc, |s| text::page_count(s)).unwrap();
    for query in ["of the", "in the"] {
        let batches = run(store, &doc, query, &opts(false, false));
        let hits = all_hits(&batches);
        let mut expected = 0usize;
        for page in 0..page_count {
            expected += collapse(&page_text(store, &doc, page))
                .to_lowercase()
                .matches(query)
                .count();
        }
        assert_eq!(hits.len(), expected, "hit count for \"{query}\"");
        for (page, hit) in &hits {
            let range = page_text_range(store, &doc, *page, hit.char_start, hit.char_len);
            assert_eq!(collapse(&range).to_lowercase(), query);
            assert_eq!(hit.context.matched.to_lowercase(), query);
        }
    }
}

/// Char indices are PDFium char indices, not UTF-8 byte offsets: accented text must still
/// round-trip through `extract_range`.
fn b2_char_indices_are_char_not_byte_offsets_on_unicode_pdf(store: &SessionStore) {
    let doc = open(store, &fixture("unicode.pdf"));
    let text0 = page_text(store, &doc, 0);
    assert!(text0.contains("ção"), "sanity: unicode.pdf has \"ção\"");
    let expected = text0.to_lowercase().matches("ção").count();

    let batches = run(store, &doc, "ção", &opts(false, false));
    let hits = all_hits(&batches);
    assert_eq!(hits.len(), expected);
    for (page, hit) in &hits {
        assert_eq!(
            page_text_range(store, &doc, *page, hit.char_start, hit.char_len).to_lowercase(),
            "ção"
        );
        assert_eq!(hit.context.matched.to_lowercase(), "ção");
        // Context is built from chars: never a mangled/truncated multi-byte sequence, never
        // longer than ~60 chars a side.
        assert!(hit.context.before.chars().count() <= 61);
        assert!(hit.context.after.chars().count() <= 61);
    }
    // The accented prose guarantees multi-byte chars appear in at least one context.
    assert!(hits.iter().any(|(_, h)| {
        h.context
            .before
            .chars()
            .chain(h.context.after.chars())
            .any(|c| !c.is_ascii())
    }));
}

fn b2_context_is_bounded_and_whitespace_collapsed(store: &SessionStore) {
    let doc = open(store, &fixture("text.pdf"));
    let batches = run(store, &doc, "booklet", &opts(false, false));
    let hits = all_hits(&batches);
    assert!(!hits.is_empty());
    for (page, hit) in hits {
        for part in [
            &hit.context.before,
            &hit.context.matched,
            &hit.context.after,
        ] {
            assert!(!part.contains("  "), "no runs of spaces in {part:?}");
            assert!(
                !part.contains(['\r', '\n', '\t']),
                "no raw line breaks in {part:?}"
            );
        }
        assert!(hit.context.before.chars().count() <= 61);
        assert!(hit.context.after.chars().count() <= 61);
        assert!(!hit.context.before.is_empty());
        // The three parts, read back to back, are a verbatim stretch of the page's collapsed text.
        let read = format!(
            "{}{}{}",
            hit.context.before, hit.context.matched, hit.context.after
        );
        assert!(
            collapse(&page_text(store, &doc, page)).contains(&read),
            "context {read:?} is not a stretch of the page text"
        );
    }
}

// --- B10: progress -------------------------------------------------------------------------

fn b10_progress_every_25_pages_without_matches(store: &SessionStore) {
    let doc = open(store, &fixture("500-page.pdf"));
    let batches = run(store, &doc, "zzzzqqqq", &opts(false, false));

    assert!(all_hits(&batches).is_empty());
    let (done, progress) = batches.split_last().unwrap();
    assert!(done.done, "the last batch is `done`");
    assert_eq!(done.pages_searched, 500);
    assert_eq!(done.page_count, 500);
    assert!(progress.iter().all(|b| !b.done));

    let steps: Vec<u32> = progress.iter().map(|b| b.pages_searched).collect();
    let expected: Vec<u32> = (1..=20).map(|i| i * PROGRESS_EVERY_PAGES).collect();
    assert_eq!(
        steps, expected,
        "a progress batch every 25 pages, nothing between"
    );
    assert!(progress.iter().all(|b| b.page_count == 500));
    assert!(progress.iter().all(|b| b.matches.is_empty()));
}

fn b10_pages_searched_is_monotonic_and_done_equals_page_count(store: &SessionStore) {
    let doc = open(store, &fixture("500-page.pdf"));
    // "Page 4" hits pages 4, 40-49, 400-499 etc. — hit batches interleave with progress batches.
    let batches = run(store, &doc, "Page 4", &opts(true, false));
    assert!(!all_hits(&batches).is_empty());

    let mut last = 0;
    for b in &batches {
        // Non-decreasing: the final page may emit a hit/progress batch and then `done`, both at
        // `page_count`.
        assert!(
            b.pages_searched >= last,
            "monotonic: {} after {last}",
            b.pages_searched
        );
        assert!(b.pages_searched <= b.page_count);
        last = b.pages_searched;
    }
    let done = batches.last().unwrap();
    assert!(done.done);
    assert_eq!(done.pages_searched, done.page_count);
    assert_eq!(done.page_count, 500);
    assert_eq!(
        batches.iter().filter(|b| b.done).count(),
        1,
        "exactly one done batch"
    );
    // No gap of 25 or more pages without a batch.
    let mut prev = 0;
    for b in &batches {
        assert!(b.pages_searched - prev <= PROGRESS_EVERY_PAGES);
        prev = b.pages_searched;
    }
}

// --- textless ------------------------------------------------------------------------------

fn textless_is_true_only_when_no_page_has_text(store: &SessionStore) {
    let scanned = open(store, &fixture("scanned.pdf"));
    let batches = run(store, &scanned, "anything", &opts(false, false));
    let done = batches.last().unwrap();
    assert!(done.done);
    assert!(done.textless, "scanned.pdf has no extractable text");
    assert!(all_hits(&batches).is_empty());

    for name in ["text.pdf", "unicode.pdf", "500-page.pdf"] {
        let doc = open(store, &fixture(name));
        // A query that does NOT match: textless must come from the page text, not from hits.
        let batches = run(store, &doc, "zzzzqqqq", &opts(false, false));
        let done = batches.last().unwrap();
        assert!(done.done);
        assert!(
            !done.textless,
            "{name} has extractable text even with zero hits"
        );
    }

    // Only the `done` batch carries a meaningful `textless`; progress batches never claim it.
    let doc = open(store, &fixture("500-page.pdf"));
    let batches = run(store, &doc, "zzzzqqqq", &opts(false, false));
    assert!(batches.iter().filter(|b| !b.done).all(|b| !b.textless));
}

// --- B11: geometry --------------------------------------------------------------------------

/// Each hit's rects must be the union of the `page_layout` char boxes for
/// `[char_start, char_start + char_len)`, line by line — i.e. search rects and the selection layer
/// agree on coordinates, whatever the page's /Rotate or CropBox is.
fn assert_hit_geometry_matches_page_layout(
    store: &SessionStore,
    doc: &str,
    page: u32,
    hit: &SearchHit,
) {
    let boxes = layout(store, doc, page);
    let range: Vec<&CharBox> = boxes
        .iter()
        .filter(|b| b.char_index >= hit.char_start && b.char_index < hit.char_start + hit.char_len)
        .collect();
    assert!(
        !range.is_empty(),
        "layout has boxes for the hit's char range"
    );

    for (i, rect) in hit.rects.iter().map(|r| &r.rect).enumerate() {
        // Chars of the range whose box centre falls in this rect = this line's chars. Their
        // union must reproduce the rect.
        let line: Vec<&&CharBox> = range
            .iter()
            .filter(|b| center_inside(&b.rect, rect))
            .collect();
        assert!(
            !line.is_empty(),
            "rect #{i} {rect:?} contains no char of the hit"
        );
        let left = line.iter().map(|b| b.rect.x).fold(f64::MAX, f64::min);
        let bottom = line.iter().map(|b| b.rect.y).fold(f64::MAX, f64::min);
        let right = line
            .iter()
            .map(|b| b.rect.x + b.rect.width)
            .fold(f64::MIN, f64::max);
        let top = line
            .iter()
            .map(|b| b.rect.y + b.rect.height)
            .fold(f64::MIN, f64::max);
        let union = Rect {
            x: left,
            y: bottom,
            width: right - left,
            height: top - bottom,
        };
        assert!(
            rect_approx_eq(&union, rect),
            "rect #{i} {rect:?} != union of page_layout boxes {union:?}"
        );
    }
    // And every char of the range sits in some rect (no char of the hit is left uncovered).
    // (Generated line-break chars between two segments legitimately sit outside every rect.)
    for b in &range {
        if page_text_range(store, doc, page, b.char_index, 1)
            .trim()
            .is_empty()
        {
            continue;
        }
        assert!(
            hit.rects.iter().any(|r| center_inside(&b.rect, &r.rect)),
            "char {} of the hit is outside every rect",
            b.char_index
        );
    }
}

fn b11_geometry_agrees_with_page_layout_on_every_page_kind(
    store: &SessionStore,
    wrapped: &Path,
    rotated: &Path,
    cropped: &Path,
) {
    // PDFium reads a /Rotate 90 page in rotated reading order (line 2 of the content stream comes
    // first), so "lazy\r\ndog" is NOT adjacent there; "eta alpha" is the phrase that wraps.
    let cases = [
        ("plain", wrapped, "lazy dog", 2usize, 2usize),
        ("/Rotate 90", rotated, "lazy dog", 1, 1),
        ("/Rotate 90", rotated, "eta alpha", 1, 2),
        ("CropBox", cropped, "lazy dog", 2, 2),
    ];
    // The unwrapped "lazy dog" on line 2 must have the same rect on every page kind: search
    // rects, like `page_layout`, are in unrotated PDF user space (origin = MediaBox lower-left)
    // whatever /Rotate or CropBox say; the UI applies the same mapping to both.
    let mut unwrapped_rects = Vec::new();
    for (label, path, query, want_hits, want_first_rects) in cases {
        let doc = open(store, path);
        let batches = run(store, &doc, query, &opts(false, false));
        let hits = all_hits(&batches);
        assert_eq!(hits.len(), want_hits, "{label}: hits for {query:?}");
        assert_eq!(
            hits[0].1.rects.len(),
            want_first_rects,
            "{label}: rects of the first hit for {query:?}"
        );
        for (page, hit) in &hits {
            assert_hit_geometry_matches_page_layout(store, &doc, *page, hit);
            assert_eq!(
                collapse(&page_text_range(
                    store,
                    &doc,
                    *page,
                    hit.char_start,
                    hit.char_len
                ))
                .to_lowercase(),
                query
            );
        }
        if query == "lazy dog" {
            unwrapped_rects.push(hits.last().unwrap().1.rects[0].rect.clone());
        }
    }
    for r in &unwrapped_rects[1..] {
        assert!(
            rect_approx_eq(r, &unwrapped_rects[0]),
            "same user-space rect regardless of /Rotate and CropBox: {r:?} vs {:?}",
            unwrapped_rects[0]
        );
    }
}

fn b11_geometry_agrees_with_page_layout_on_text_pdf(store: &SessionStore) {
    let doc = open(store, &fixture("text.pdf"));
    for query in ["the", "of the"] {
        let batches = run(store, &doc, query, &opts(false, false));
        for (page, hit) in all_hits(&batches) {
            assert_hit_geometry_matches_page_layout(store, &doc, page, hit);
        }
    }
}

/// `char_start` is PDFium's own start index, not an approximation: cross-check against
/// `FPDFText_FindStart(.., start_index)` (the largest start index from which the search still
/// yields this occurrence first IS the occurrence's start).
fn char_start_matches_pdfiums_own_result_index(store: &SessionStore, wrapped: &Path) {
    let wrapped_doc = open(store, wrapped);
    let text_doc = open(store, &fixture("text.pdf"));
    let unicode_doc = open(store, &fixture("unicode.pdf"));
    let mut cases: Vec<(&DocId, u32, &str)> = vec![
        (&wrapped_doc, 0, "lazy dog"),
        (&unicode_doc, 0, "ção"),
        (&unicode_doc, 0, "de a"),
    ];
    for page in 0..3 {
        for query in ["the", "of the", "a", "in a"] {
            cases.push((&text_doc, page, query));
        }
    }
    let mut checked = 0;
    for (doc, page, query) in cases {
        let batches = run(store, doc, query, &opts(false, false));
        let hits: Vec<(u32, SearchHit)> = all_hits(&batches)
            .into_iter()
            .filter(|(p, _)| *p == page)
            .map(|(p, h)| (p, h.clone()))
            .collect();
        checked += hits.len();
        let q = query.to_owned();
        let expected_starts: Vec<(u32, u32)> = store
            .with_session(doc, move |s| {
                let pdf_page = s.document().pages().get(page as PdfPageIndex).unwrap();
                let text = pdf_page.text().unwrap();
                let n = text.len() as usize;
                let o = PdfSearchOptions::new();
                // first segment rect of each occurrence as found by a search started at `c`
                let first_rect = |c: usize| {
                    let search = text.search_from(&q, &o, c).ok()?;
                    let segs = search.find_next()?;
                    let b = segs.first().ok()?.bounds();
                    Some((
                        b.left().value,
                        b.bottom().value,
                        b.right().value,
                        b.top().value,
                    ))
                };
                let mut starts = Vec::new();
                let mut c = 0usize;
                let mut prev_rect = None;
                while c < n {
                    let r = first_rect(c);
                    if r.is_none() {
                        break;
                    }
                    // `c` is the largest start index yielding rect `r` first: scan forward.
                    let mut last = c;
                    while last + 1 < n && first_rect(last + 1) == r {
                        last += 1;
                    }
                    if prev_rect != r {
                        starts.push((last as u32, 0));
                    }
                    prev_rect = r;
                    c = last + 1;
                }
                starts
            })
            .unwrap();
        let got: Vec<u32> = hits.iter().map(|(_, h)| h.char_start).collect();
        let want: Vec<u32> = expected_starts.iter().map(|(s, _)| *s).collect();
        assert_eq!(
            got, want,
            "char_start of every \"{query}\" hit on page {page}"
        );
    }
    assert!(
        checked > 50,
        "the cross-check actually exercised many hits ({checked})"
    );
}

// --- cancellation & duplicate ids ----------------------------------------------------------

fn cancel_before_start_emits_nothing(store: &SessionStore) {
    let doc = open(store, &fixture("500-page.pdf"));
    let cancelled = AtomicBool::new(true);
    let batches = run_with(store, &doc, "Page", &opts(false, false), &cancelled, |_| {});
    assert!(
        batches.is_empty(),
        "a search cancelled up front emits no batch and no done"
    );
}

fn cancel_mid_search_stops_batches_and_never_sends_done(store: &SessionStore) {
    let doc = open(store, &fixture("500-page.pdf"));
    let registry = SearchRegistry::default();
    let flag = text::register_search(&registry, "mid-search").unwrap();
    let mut seen = 0;
    // "Page" matches every page, so a hit batch is emitted per page.
    let batches = run_with(store, &doc, "Page", &opts(false, false), &flag, |_| {
        seen += 1;
        if seen == 3 {
            registry.cancel("mid-search");
        }
    });
    assert!(flag.load(Ordering::Relaxed));
    assert_eq!(batches.len(), 3, "no batch after the cancel");
    assert!(
        batches.iter().all(|b| !b.done),
        "a cancelled search never emits `done`"
    );
}

fn cancel_of_unknown_id_is_a_silent_noop_and_ids_are_reusable_after_finish(_store: &SessionStore) {
    let registry = SearchRegistry::default();
    registry.cancel("never-existed"); // must not panic
    let flag = text::register_search(&registry, "reuse").unwrap();
    registry.finish("reuse");
    assert!(!flag.load(Ordering::Relaxed), "finish does not cancel");
    text::register_search(&registry, "reuse").expect("a finished id can be reused");
}

fn duplicate_search_id_is_invalid_arg(_store: &SessionStore) {
    let registry = SearchRegistry::default();
    text::register_search(&registry, "dup").expect("first registration");
    let err = text::register_search(&registry, "dup").expect_err("duplicate id");
    assert!(
        matches!(err.code, RubricaErrorCode::InvalidArg),
        "got {err:?}"
    );
    // Cancelling frees the id again.
    registry.cancel("dup");
    text::register_search(&registry, "dup").expect("re-register after cancel");
}

fn closed_document_ends_the_search_silently(store: &SessionStore, wrapped: &Path) {
    let doc = open(store, wrapped);
    let page_count = store.with_session(&doc, |s| text::page_count(s)).unwrap();
    assert_eq!(page_count, 1);
    let plan = pipeline::prepare(store, &doc, &query_of("lazy", opts(false, false))).unwrap();
    // The plan was prepared before the close; the page hop now finds no document.
    store
        .with_store({
            let doc = doc.clone();
            move |sessions| {
                sessions.remove(&doc);
            }
        })
        .unwrap();
    let mut batches = Vec::new();
    let completed = pipeline::run(
        store,
        &doc,
        "closed",
        plan,
        &AtomicBool::new(false),
        |batch| batches.push(batch),
    );
    assert!(!completed);
    assert!(
        batches.is_empty(),
        "a search on a closed document ends silently"
    );
}

#[test]
fn search_engine() {
    init_journal_dir();
    let store = SessionStore::default();
    let scratch = tempfile::tempdir().expect("tempdir");
    let (wrapped, rotated, cropped) = write_synth_pdfs(scratch.path());

    // Every sub-test runs even if an earlier one fails, so one run reports every failing bug.
    let mut failures: Vec<&str> = Vec::new();
    macro_rules! case {
        ($name:ident($($arg:expr),*)) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $name($($arg),*))).is_err()
            {
                failures.push(stringify!($name));
            }
        };
    }

    case!(b2_wrapped_occurrence_is_one_hit_with_one_rect_per_line(
        &store, &wrapped
    ));
    case!(b2_hit_count_matches_an_independent_substring_count_on_text_pdf(&store));
    case!(b2_multiword_queries_on_text_pdf_group_per_occurrence(
        &store
    ));
    case!(b2_char_indices_are_char_not_byte_offsets_on_unicode_pdf(
        &store
    ));
    case!(b2_context_is_bounded_and_whitespace_collapsed(&store));
    case!(b10_progress_every_25_pages_without_matches(&store));
    case!(b10_pages_searched_is_monotonic_and_done_equals_page_count(
        &store
    ));
    case!(textless_is_true_only_when_no_page_has_text(&store));
    case!(b11_geometry_agrees_with_page_layout_on_every_page_kind(
        &store, &wrapped, &rotated, &cropped
    ));
    case!(b11_geometry_agrees_with_page_layout_on_text_pdf(&store));
    case!(char_start_matches_pdfiums_own_result_index(
        &store, &wrapped
    ));
    case!(cancel_before_start_emits_nothing(&store));
    case!(cancel_mid_search_stops_batches_and_never_sends_done(&store));
    case!(cancel_of_unknown_id_is_a_silent_noop_and_ids_are_reusable_after_finish(&store));
    case!(duplicate_search_id_is_invalid_arg(&store));
    case!(closed_document_ends_the_search_silently(&store, &wrapped));

    assert!(failures.is_empty(), "failing sub-tests: {failures:#?}");
}
