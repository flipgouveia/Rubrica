//! S8: the search v2 pipeline (`engine::search::pipeline::{prepare, run}`) end to end against the
//! real fixtures, driven with a bare `SessionStore` exactly like `commands/text.rs` drives it
//! (PDFium only ever runs on the store's owner thread).
//!
//! Ground truth comes from `fixtures/book.expected.json` (computed by the fixture generator from
//! the strings it draws), never from numbers hard-coded here, except the handful of values the
//! task brief pins (tight trio score 125, loose trio 386, outline ids "2" / "2.1").
//!
//! As in `engine_fixtures.rs`/`search_engine.rs` every sub-test is a plain function called in
//! sequence from the one `#[test]`, sharing one `SessionStore`, so the vendored PDFium build only
//! ever sees one owner-thread identity. Each sub-test runs even if an earlier one failed, so one
//! run reports every failing check.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Once;

use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::history::test_commands::InsertBlankPageCommand;
use rubrica_lib::engine::redact::RedactCommand;
use rubrica_lib::engine::search::pipeline::{self, PROGRESS_EVERY_PAGES};
use rubrica_lib::types::{
    DocId, ProximityOptions, RubricaErrorCode, SearchBatch, SearchHit, SearchMode, SearchQuery,
    SearchScope,
};
use serde_json::Value;

static INIT: Once = Once::new();

fn init_journal_dir() {
    INIT.call_once(|| {
        let dir =
            std::env::temp_dir().join(format!("rubrica-search-v2-pipeline-{}", std::process::id()));
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

fn open_path(store: &SessionStore, path: &Path) -> DocId {
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

fn open(store: &SessionStore, name: &str) -> DocId {
    open_path(store, &fixture(name))
}

fn close(store: &SessionStore, doc: &str) {
    let doc = doc.to_owned();
    store
        .with_store(move |sessions| {
            sessions.remove(&doc);
        })
        .expect("owner thread alive");
}

fn expected() -> Value {
    let raw = std::fs::read_to_string(fixture("book.expected.json")).expect("book.expected.json");
    serde_json::from_str(&raw).expect("valid JSON")
}

/// Id (child-index path from the root, like `engine::outline`) of the deepest entry of the JSON
/// outline whose `[page, pageEnd]` contains `page`.
fn expected_outline_id(outline: &Value, page: u32) -> Option<String> {
    fn walk(items: &Value, page: u32, prefix: &str) -> Option<String> {
        for (i, item) in items.as_array()?.iter().enumerate() {
            let id = if prefix.is_empty() {
                i.to_string()
            } else {
                format!("{prefix}.{i}")
            };
            let (start, end) = (item["page"].as_u64()?, item["pageEnd"].as_u64()?);
            if (start..=end).contains(&(page as u64)) {
                return Some(walk(&item["children"], page, &id).unwrap_or(id));
            }
        }
        None
    }
    walk(outline, page, "")
}

// --- query / run helpers -------------------------------------------------------------------

fn phrase(text: &str) -> SearchQuery {
    SearchQuery {
        text: text.to_owned(),
        mode: SearchMode::Phrase,
        proximity: None,
        scope: SearchScope::All,
        case_sensitive: false,
        whole_word: false,
        ignore_diacritics: true,
        exclude_headers_footers: false,
    }
}

fn proximity(text: &str, window: u32) -> SearchQuery {
    SearchQuery {
        mode: SearchMode::Proximity,
        proximity: Some(ProximityOptions { window }),
        ..phrase(text)
    }
}

struct Run {
    batches: Vec<SearchBatch>,
    completed: bool,
}

impl Run {
    fn hits(&self) -> Vec<(u32, &SearchHit)> {
        self.batches
            .iter()
            .flat_map(|b| &b.matches)
            .flat_map(|m| m.hits.iter().map(move |h| (m.page, h)))
            .collect()
    }

    fn done(&self) -> &SearchBatch {
        let last = self.batches.last().expect("at least a done batch");
        assert!(last.done, "the last batch is `done`");
        last
    }

    /// Hit count per start page.
    fn per_page(&self) -> BTreeMap<u32, usize> {
        let mut map = BTreeMap::new();
        for (page, _) in self.hits() {
            *map.entry(page).or_insert(0) += 1;
        }
        map
    }
}

fn run_with(
    store: &SessionStore,
    doc: &str,
    query: &SearchQuery,
    cancelled: &AtomicBool,
    mut on_batch: impl FnMut(&SearchBatch),
) -> Run {
    let plan = pipeline::prepare(store, doc, query).expect("valid query");
    let mut batches = Vec::new();
    let completed = pipeline::run(store, doc, "test-search", plan, cancelled, |batch| {
        on_batch(&batch);
        batches.push(batch);
    });
    Run { batches, completed }
}

fn run(store: &SessionStore, doc: &str, query: &SearchQuery) -> Run {
    run_with(store, doc, query, &AtomicBool::new(false), |_| {})
}

fn invalid_arg(store: &SessionStore, doc: &str, query: &SearchQuery, what: &str) {
    match pipeline::prepare(store, doc, query) {
        Ok(_) => panic!("{what}: expected INVALID_ARG, got a plan"),
        Err(err) => assert_eq!(err.code, RubricaErrorCode::InvalidArg, "{what}: {err:?}"),
    }
}

/// Invariants every run must satisfy (CONTRACTS v1.2.0 §4): monotonic progress, exactly one
/// `done` that is last, every page's hits in ONE batch, pages ascending, hits within a page in
/// document order, a page only emitted once the next one has been matched, and `ranked` only on
/// a proximity `done`.
fn check_batch_rules(run: &Run, mode: SearchMode, scope_start: u32) {
    assert!(run.completed, "the run reached `done`");
    let done = run.done();
    assert_eq!(done.pages_searched, done.page_count);
    assert_eq!(run.batches.iter().filter(|b| b.done).count(), 1);

    let mut last_searched = 0;
    let mut last_page: Option<u32> = None;
    for batch in &run.batches {
        assert!(batch.pages_searched >= last_searched, "monotonic progress");
        assert!(batch.pages_searched <= batch.page_count);
        assert_eq!(batch.page_count, done.page_count, "page_count is constant");
        last_searched = batch.pages_searched;

        assert_eq!(
            batch.ranked,
            batch.done && mode == SearchMode::Proximity,
            "`ranked` only on a proximity done batch"
        );
        for m in &batch.matches {
            if let Some(prev) = last_page {
                assert!(
                    m.page > prev,
                    "page {} appears after page {prev}: every page's hits travel in exactly one \
                     batch, in page order",
                    m.page
                );
            }
            last_page = Some(m.page);
            assert!(!m.hits.is_empty(), "no empty match groups");
            if !batch.done {
                assert!(
                    m.page + 2 <= scope_start + batch.pages_searched,
                    "page {} was emitted before the next page had been matched",
                    m.page
                );
            }
            let starts: Vec<u32> = m.hits.iter().map(|h| h.char_start).collect();
            assert!(
                starts.windows(2).all(|w| w[0] <= w[1]),
                "page {}: hits in document order, got {starts:?}",
                m.page
            );
        }
    }
}

// --- book.pdf: phrase ----------------------------------------------------------------------

/// Whole-word "contrato": per page = body count + titles/headers + the hyphen-split one, grouped
/// by start page, one batch per page, outline id = deepest entry for the start page.
fn phrase_contrato_whole_word_on_book(store: &SessionStore) {
    let exp = expected();
    let doc = open(store, "book.pdf");
    let mut q = phrase("contrato");
    q.whole_word = true;
    let r = run(store, &doc, &q);
    check_batch_rules(&r, SearchMode::Phrase, 0);

    // Expected per page: body + headings + running headers + the `contra\u{2}to` of the
    // hyphenated zone (counted by the matcher, not by `contrato.byPage`).
    let mut want: BTreeMap<u32, usize> = BTreeMap::new();
    let mut add = |obj: &Value| {
        for (page, n) in obj.as_object().unwrap() {
            *want.entry(page.parse().unwrap()).or_insert(0) += n.as_u64().unwrap() as usize;
        }
    };
    add(&exp["contrato"]["byPage"]);
    add(&exp["contratoInTitles"]["headings"]["byPage"]);
    add(&exp["contratoInTitles"]["headers"]["byPage"]);
    *want
        .entry(exp["hyphenated"]["contrato"]["page"].as_u64().unwrap() as u32)
        .or_insert(0) += 1;
    want.retain(|_, n| *n > 0);

    let total_expected = exp["contrato"]["total"].as_u64().unwrap()
        + exp["contratoInTitles"]["total"].as_u64().unwrap()
        + 1;
    assert_eq!(r.hits().len() as u64, total_expected);
    assert_eq!(r.per_page(), want, "hits grouped by start page");

    let done = r.done();
    assert_eq!(done.page_count, exp["pageCount"].as_u64().unwrap() as u32);
    assert!(!done.textless);
    assert!(!done.ranked);
    assert!(done.furniture.is_empty() && r.batches.iter().all(|b| b.furniture.is_empty()));

    for (page, hit) in r.hits() {
        assert_eq!(
            hit.outline_item_id,
            expected_outline_id(&exp["outline"], page),
            "outline id of a hit on page {page}"
        );
        assert!(hit.spans_pages.is_none() && hit.score.is_none());
        assert!(!hit.rects.is_empty() && hit.window_rects.is_empty());
        assert!(hit.rects.iter().all(|rect| rect.page == page));
        assert_eq!(
            hit.context.matched.to_lowercase().replace('-', ""),
            "contrato"
        );
    }
    // The pinned examples from the brief.
    let on = |page: u32| {
        r.hits()
            .into_iter()
            .find(|(p, _)| *p == page)
            .unwrap()
            .1
            .outline_item_id
            .clone()
    };
    assert_eq!(
        on(16).as_deref(),
        Some("2.1"),
        "page 16 is 3.2 Por incumprimento"
    );
    assert_eq!(
        on(15).as_deref(),
        Some("2.0"),
        "page 15 is 3.1 Por acordo, the first child of chapter 3 (\"2\")"
    );
    assert!(
        !r.per_page().contains_key(&0),
        "title page has no `contrato` (and no outline entry)"
    );

    // The hyphen-split word is one hit with one rect per line.
    let split = exp["hyphenated"]["contrato"]["page"].as_u64().unwrap() as u32;
    assert!(
        r.hits()
            .iter()
            .any(|(p, h)| *p == split && h.rects.len() == 2),
        "contra-/to on page {split} is ONE hit with two rects"
    );
}

/// Without whole word the same query also matches inside longer words ("contratos"); a case
/// sensitive query drops the capitalised running headers.
fn phrase_options_widen_and_narrow_results(store: &SessionStore) {
    let doc = open(store, "book.pdf");
    let mut whole = phrase("contrato");
    whole.whole_word = true;
    let n_whole = run(store, &doc, &whole).hits().len();
    let n_any = run(store, &doc, &phrase("contrato")).hits().len();
    assert!(
        n_any > n_whole,
        "\"contratos\" etc. match without whole word"
    );

    // case-sensitive: the capitalised "Contratos" of the running headers goes away.
    let mut cs = phrase("contrato");
    cs.case_sensitive = true;
    assert!(run(store, &doc, &cs).hits().len() < n_any);
}

// --- book.pdf: proximity -------------------------------------------------------------------

fn proximity_windows_scopes_and_ranking(store: &SessionStore) {
    let exp = expected();
    let tight = &exp["tightTrio"];
    let loose = &exp["looseTrio"];
    let (tight_page, loose_page) = (
        tight["page"].as_u64().unwrap() as u32,
        loose["page"].as_u64().unwrap() as u32,
    );
    let (tight_span, loose_span) = (
        tight["spanChars"].as_u64().unwrap() as u32,
        loose["spanChars"].as_u64().unwrap() as u32,
    );
    assert_eq!((tight_span, loose_span), (125, 386));
    let doc = open(store, "book.pdf");
    let text = "rescisão prazo indemnização";

    // 100 is too small for either; 250 finds the tight trio only; 500 finds both.
    let r100 = run(store, &doc, &proximity(text, 100));
    check_batch_rules(&r100, SearchMode::Proximity, 0);
    assert!(r100.hits().is_empty());
    assert!(
        r100.done().ranked,
        "an empty proximity run is still ranked on done"
    );

    let r250 = run(store, &doc, &proximity(text, 250));
    check_batch_rules(&r250, SearchMode::Proximity, 0);
    let hits = r250.hits();
    assert_eq!(hits.len(), 1, "only the tight trio fits 250");
    let (page, hit) = hits[0];
    assert_eq!(page, tight_page);
    assert_eq!(hit.score, Some(tight_span));
    assert_eq!(hit.outline_item_id.as_deref(), Some("2.1"));
    assert_eq!(
        hit.window_rects.len(),
        2,
        "the tight trio window runs from `rescisão` (line 1) to `indemnização` (line 2)"
    );
    let mut terms: Vec<u8> = hit.rects.iter().map(|r| r.term).collect();
    terms.sort_unstable();
    terms.dedup();
    assert_eq!(terms, [0, 1, 2], "every term is highlighted");
    assert!(!hit.context.terms.is_empty());
    assert!(hit.spans_pages.is_none());
    assert!(
        r250.batches[..r250.batches.len() - 1]
            .iter()
            .all(|b| !b.ranked),
        "`ranked` only on done"
    );
    assert!(r250.done().ranked);

    let r500 = run(store, &doc, &proximity(text, 500));
    check_batch_rules(&r500, SearchMode::Proximity, 0);
    let by_page = r500.per_page();
    assert_eq!(
        by_page.keys().copied().collect::<Vec<_>>(),
        [tight_page, loose_page]
    );
    let scores: BTreeMap<u32, Option<u32>> =
        r500.hits().iter().map(|(p, h)| (*p, h.score)).collect();
    assert_eq!(scores[&tight_page], Some(tight_span));
    assert_eq!(scores[&loose_page], Some(loose_span));
    for (page, hit) in r500.hits() {
        assert_eq!(
            hit.outline_item_id,
            expected_outline_id(&exp["outline"], page)
        );
    }
    // The 500-char run reports hits in document order; ranking is the UI's job (`ranked`).
    let pages: Vec<u32> = r500.hits().iter().map(|(p, _)| *p).collect();
    assert_eq!(pages, [tight_page, loose_page]);

    // Scope by outline entry "2" (3 Cessação do contrato): pages 15..=22 -> the tight trio only.
    let mut scoped = proximity(text, 500);
    scoped.scope = SearchScope::Outline {
        item_id: "2".into(),
    };
    let r = run(store, &doc, &scoped);
    check_batch_rules(&r, SearchMode::Proximity, 15);
    assert_eq!(r.done().page_count, 8, "pages 15..=22");
    assert_eq!(r.done().pages_searched, 8);
    assert_eq!(r.hits().len(), 1);
    assert_eq!(r.hits()[0].0, tight_page);
    assert!(r.hits().iter().all(|(p, _)| (15..=22).contains(p)));

    // The nested entry "2.1" (3.2 Por incumprimento): pages 16..=19.
    let mut nested = phrase("contrato");
    nested.scope = SearchScope::Outline {
        item_id: "2.1".into(),
    };
    let r = run(store, &doc, &nested);
    check_batch_rules(&r, SearchMode::Phrase, 16);
    assert_eq!(r.done().page_count, 4);
    assert!(!r.hits().is_empty());
    assert!(r.hits().iter().all(|(p, _)| (16..=19).contains(p)));

    // Scope by page range.
    for (from, to, want) in [
        (tight_page, tight_page, vec![tight_page]),
        (loose_page, loose_page, vec![loose_page]),
        (tight_page, loose_page, vec![tight_page, loose_page]),
        (0, tight_page - 1, vec![]),
        (tight_page + 1, loose_page - 1, vec![]),
    ] {
        let mut q = proximity(text, 500);
        q.scope = SearchScope::Pages { from, to };
        let r = run(store, &doc, &q);
        check_batch_rules(&r, SearchMode::Proximity, from);
        assert_eq!(r.done().page_count, to - from + 1, "pages {from}-{to}");
        assert_eq!(
            r.hits().iter().map(|(p, _)| *p).collect::<Vec<_>>(),
            want,
            "pages {from}-{to}"
        );
    }

    // The decoys (4 pages apart) never join, whatever the window.
    let r = run(store, &doc, &proximity("rescisão indemnização", 5000));
    for (page, hit) in r.hits() {
        assert!(
            page == tight_page || page == loose_page || hit.score.is_some(),
            "unexpected zone on page {page}"
        );
        assert!(
            hit.spans_pages.is_none(),
            "no window joins pages 33 and 37: {:?}",
            hit.spans_pages
        );
    }
}

fn prepare_rejects_bad_arguments(store: &SessionStore) {
    let doc = open(store, "book.pdf");
    let nested = open(store, "book-no-outline.pdf");

    invalid_arg(store, &doc, &phrase(""), "empty text");
    invalid_arg(store, &doc, &phrase("   "), "blank text");
    invalid_arg(
        store,
        &doc,
        &proximity("-rescisão", 500),
        "proximity with only an excluded term",
    );
    invalid_arg(store, &doc, &proximity("  ", 500), "proximity, blank text");
    let mut no_window = proximity("rescisão prazo", 500);
    no_window.proximity = None;
    invalid_arg(store, &doc, &no_window, "proximity without options");
    for window in [0, 19, 5001, u32::MAX] {
        invalid_arg(
            store,
            &doc,
            &proximity("rescisão prazo", window),
            &format!("window {window}"),
        );
    }
    // The bounds themselves are fine.
    for window in [20, 5000] {
        pipeline::prepare(store, &doc, &proximity("rescisão prazo", window))
            .unwrap_or_else(|e| panic!("window {window}: {e:?}"));
    }

    for (from, to) in [(5, 4), (0, 40), (40, 40), (100, 200)] {
        let mut q = phrase("contrato");
        q.scope = SearchScope::Pages { from, to };
        invalid_arg(store, &doc, &q, &format!("pages {from}-{to}"));
    }
    let mut last = phrase("contrato");
    last.scope = SearchScope::Pages { from: 39, to: 39 };
    pipeline::prepare(store, &doc, &last).expect("the last page is a valid range");

    for id in ["99", "", "0.9", "2.1.5", "abc"] {
        let mut q = phrase("contrato");
        q.scope = SearchScope::Outline { item_id: id.into() };
        invalid_arg(store, &doc, &q, &format!("outline item {id:?}"));
    }
    // A document without bookmarks cannot be scoped by outline.
    let mut q = phrase("contrato");
    q.scope = SearchScope::Outline {
        item_id: "0".into(),
    };
    invalid_arg(store, &nested, &q, "outline scope without an outline");
    // ...but searches as if it had none otherwise, and hits carry no outline id.
    let r = run(store, &nested, &phrase("contrato"));
    assert!(!r.hits().is_empty());
    assert!(r.hits().iter().all(|(_, h)| h.outline_item_id.is_none()));

    // An unknown document is NOT_FOUND, not INVALID_ARG.
    let err = pipeline::prepare(store, "no-such-doc", &phrase("contrato"))
        .err()
        .expect("unknown document");
    assert_eq!(err.code, RubricaErrorCode::NotFound);
}

// --- headers / footers, accents ------------------------------------------------------------

fn exclude_headers_footers_and_furniture(store: &SessionStore) {
    let exp = expected();
    let doc = open(store, "book.pdf");
    let first_furniture = exp["footer"]["firstPage"].as_u64().unwrap() as u32;
    let page_count = exp["pageCount"].as_u64().unwrap() as u32;
    let with_furniture: Vec<u32> = (first_furniture..page_count).collect();

    // "Página" lives in the footers only.
    let footer = phrase("Página");
    let r = run(store, &doc, &footer);
    assert!(
        r.hits().len() >= with_furniture.len(),
        "a footer on every page but the title page ({} hits)",
        r.hits().len()
    );
    assert!(r.batches.iter().all(|b| b.furniture.is_empty()));

    let mut excluded = phrase("Página");
    excluded.exclude_headers_footers = true;
    let r = run(store, &doc, &excluded);
    check_batch_rules(&r, SearchMode::Phrase, 0);
    assert!(
        r.hits().is_empty(),
        "footers are excluded: {:?}",
        r.per_page()
    );

    // Furniture: every page with a header/footer reported exactly once, in the batch that
    // covers it (never ahead of `pagesSearched`), header and footer rect on each.
    let mut seen: BTreeMap<u32, usize> = BTreeMap::new();
    let mut previous_searched = 0;
    for batch in &r.batches {
        for f in &batch.furniture {
            assert!(
                f.page >= previous_searched && f.page < batch.pages_searched,
                "furniture of page {} sits in the batch for pages {previous_searched}..{}",
                f.page,
                batch.pages_searched
            );
            *seen.entry(f.page).or_insert(0) += 1;
            assert_eq!(f.rects.len(), 2, "page {}: header + footer", f.page);
            assert!(f.rects.iter().all(|r| r.width > 0.0 && r.height > 0.0));
            let (lo, hi) = (
                f.rects.iter().map(|r| r.y).fold(f64::MAX, f64::min),
                f.rects.iter().map(|r| r.y).fold(f64::MIN, f64::max),
            );
            assert!(
                lo < 60.0 && hi > 700.0,
                "footer at the bottom, header on top"
            );
        }
        previous_searched = batch.pages_searched;
    }
    assert_eq!(
        seen.keys().copied().collect::<Vec<_>>(),
        with_furniture,
        "furniture on pages 1..=39, none on the title page"
    );
    assert!(seen.values().all(|&n| n == 1));

    // Furniture also respects the scope: only the pages searched.
    let mut scoped = excluded.clone();
    scoped.scope = SearchScope::Pages { from: 10, to: 14 };
    let r = run(store, &doc, &scoped);
    let pages: Vec<u32> = r
        .batches
        .iter()
        .flat_map(|b| b.furniture.iter().map(|f| f.page))
        .collect();
    assert_eq!(pages, [10, 11, 12, 13, 14]);

    // Running headers disappear from whole-word "contrato" results; headings stay.
    let mut contrato = phrase("contrato");
    contrato.whole_word = true;
    let with_headers = run(store, &doc, &contrato).hits().len();
    contrato.exclude_headers_footers = true;
    let without = run(store, &doc, &contrato);
    let headers = exp["contratoInTitles"]["headers"]["total"]
        .as_u64()
        .unwrap() as usize;
    assert_eq!(without.hits().len(), with_headers - headers);

    // The phrase that spans the page break exists only when the footer + header between the two
    // pages are excluded.
    let cross = &exp["crossPage"];
    let (from, to) = (
        cross["fromPage"].as_u64().unwrap() as u32,
        cross["toPage"].as_u64().unwrap() as u32,
    );
    let text = cross["phrase"].as_str().unwrap();
    let mut q = phrase(text);
    let plain = run(store, &doc, &q);
    assert!(plain.hits().is_empty(), "furniture sits between the pages");
    q.exclude_headers_footers = true;
    let r = run(store, &doc, &q);
    check_batch_rules(&r, SearchMode::Phrase, 0);
    let hits = r.hits();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].0, from);
    let hit = hits[0].1;
    assert_eq!(hit.spans_pages, Some((from, to)));
    let rect_pages: Vec<u32> = hit.rects.iter().map(|rect| rect.page).collect();
    assert!(
        rect_pages.contains(&from) && rect_pages.contains(&to),
        "{rect_pages:?}"
    );
    assert_eq!(
        hit.outline_item_id,
        expected_outline_id(&exp["outline"], from),
        "outline id of the START page"
    );
    // The page-break phrase is emitted with its start page's batch (one batch per page).
    assert!(r.batches.iter().filter(|b| !b.matches.is_empty()).count() == 1);
}

fn ignore_diacritics_finds_the_acao_pages(store: &SessionStore) {
    let exp = expected();
    let doc = open(store, "book.pdf");
    let pages: Vec<u32> = exp["acaoPages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p.as_u64().unwrap() as u32)
        .collect();

    let mut q = phrase("acao");
    q.whole_word = true;
    let r = run(store, &doc, &q);
    check_batch_rules(&r, SearchMode::Phrase, 0);
    assert_eq!(r.hits().iter().map(|(p, _)| *p).collect::<Vec<_>>(), pages);
    for (page, hit) in r.hits() {
        assert_eq!(hit.context.matched, "ação", "page {page}");
        assert_eq!(
            hit.outline_item_id,
            expected_outline_id(&exp["outline"], page)
        );
    }

    q.ignore_diacritics = false;
    assert!(
        run(store, &doc, &q).hits().is_empty(),
        "with accents significant, `acao` never occurs"
    );
    q.text = "ação".into();
    assert_eq!(
        run(store, &doc, &q)
            .hits()
            .iter()
            .map(|(p, _)| *p)
            .collect::<Vec<_>>(),
        pages
    );
}

// --- progress, textless, cancellation --------------------------------------------------------

fn progress_every_25_pages_on_500_pages(store: &SessionStore) {
    let doc = open(store, "500-page.pdf");
    let r = run(store, &doc, &phrase("zzzzqqqq"));
    check_batch_rules(&r, SearchMode::Phrase, 0);
    assert!(r.hits().is_empty());
    let done = r.done();
    assert_eq!((done.pages_searched, done.page_count), (500, 500));
    assert!(!done.textless);

    let mut previous = 0;
    for batch in &r.batches {
        assert!(
            batch.pages_searched - previous <= PROGRESS_EVERY_PAGES,
            "a batch at least every {PROGRESS_EVERY_PAGES} pages ({previous} -> {})",
            batch.pages_searched
        );
        previous = batch.pages_searched;
    }
    let steps: Vec<u32> = r
        .batches
        .iter()
        .filter(|b| !b.done)
        .map(|b| b.pages_searched)
        .collect();
    assert_eq!(
        steps,
        (1..=20)
            .map(|i| i * PROGRESS_EVERY_PAGES)
            .collect::<Vec<_>>(),
        "progress only at the 25-page ticks when nothing matches"
    );
    assert!(r.batches.iter().all(|b| b.matches.is_empty()));
    assert!(r.batches.iter().filter(|b| !b.done).all(|b| !b.textless));

    // With hits on most pages the progress interleaves with the hit batches and still ends on
    // `done`.
    let r = run(store, &doc, &phrase("Page 4"));
    check_batch_rules(&r, SearchMode::Phrase, 0);
    assert!(!r.hits().is_empty());
    let mut previous = 0;
    for batch in &r.batches {
        assert!(batch.pages_searched - previous <= PROGRESS_EVERY_PAGES);
        previous = batch.pages_searched;
    }
    // Each page's hit came with its own page index (a page-number label per page).
    for (page, hit) in r.hits() {
        assert!(hit.context.matched.starts_with("Page 4"), "page {page}");
    }
}

fn textless_documents(store: &SessionStore) {
    let scanned = open(store, "scanned.pdf");
    let r = run(store, &scanned, &phrase("anything"));
    check_batch_rules(&r, SearchMode::Phrase, 0);
    assert!(r.done().textless, "scanned.pdf has no text layer");
    assert!(r.hits().is_empty());
    assert!(r.batches.iter().filter(|b| !b.done).all(|b| !b.textless));

    // Also with header/footer exclusion (the furniture pass sees only empty pages).
    let mut q = phrase("anything");
    q.exclude_headers_footers = true;
    let r = run(store, &scanned, &q);
    assert!(r.done().textless);
    assert!(r.batches.iter().all(|b| b.furniture.is_empty()));

    for name in ["text.pdf", "unicode.pdf", "book.pdf"] {
        let doc = open(store, name);
        let r = run(store, &doc, &phrase("zzzzqqqq"));
        assert!(r.completed);
        assert!(!r.done().textless, "{name} has text even with zero hits");
    }
}

fn cancellation(store: &SessionStore) {
    let doc = open(store, "500-page.pdf");

    // Cancelled up front: nothing emitted, no done.
    let flag = AtomicBool::new(true);
    let r = run_with(store, &doc, &phrase("Page"), &flag, |_| {});
    assert!(r.batches.is_empty() && !r.completed);

    // Cancelled from inside the emit callback: nothing after that batch, no done, `false`.
    for cancel_at in [1, 3] {
        let flag = AtomicBool::new(false);
        let mut seen = 0;
        let r = run_with(store, &doc, &phrase("Page"), &flag, |_| {
            seen += 1;
            if seen == cancel_at {
                flag.store(true, Ordering::Relaxed);
            }
        });
        assert!(!r.completed, "a cancelled run does not complete");
        assert_eq!(r.batches.len(), cancel_at, "no batch after the cancel");
        assert!(
            r.batches.iter().all(|b| !b.done),
            "no `done` after a cancel"
        );
    }

    // Cancelled while only progress batches flow (no hits).
    let flag = AtomicBool::new(false);
    let r = run_with(store, &doc, &phrase("zzzzqqqq"), &flag, |b| {
        if b.pages_searched >= 100 {
            flag.store(true, Ordering::Relaxed);
        }
    });
    assert!(!r.completed);
    assert_eq!(r.batches.last().unwrap().pages_searched, 100);

    // Cancelled before the header/footer detection pass: also silent.
    let book = open(store, "book.pdf");
    let mut q = phrase("contrato");
    q.exclude_headers_footers = true;
    let r = run_with(store, &book, &q, &AtomicBool::new(true), |_| {});
    assert!(r.batches.is_empty() && !r.completed);

    // A document closed after `prepare` ends the search silently.
    let plan = pipeline::prepare(store, &doc, &phrase("Page")).unwrap();
    close(store, &doc);
    let mut batches = Vec::new();
    let completed = pipeline::run(store, &doc, "gone", plan, &AtomicBool::new(false), |b| {
        batches.push(b)
    });
    assert!(!completed && batches.is_empty());
    let err = pipeline::prepare(store, &doc, &phrase("Page"))
        .err()
        .expect("closed document");
    assert_eq!(err.code, RubricaErrorCode::NotFound);
}

// --- cache + invalidation ----------------------------------------------------------------------

fn cache_state(store: &SessionStore, doc: &str, pages: Vec<u32>) -> (usize, Vec<bool>, bool) {
    store
        .with_session(doc, move |s| {
            let cache = s.search_cache();
            (
                cache.heap_bytes(),
                pages.iter().map(|&p| cache.page(p).is_some()).collect(),
                cache.furniture().is_some(),
            )
        })
        .unwrap()
}

fn serialized(run: &Run) -> String {
    serde_json::to_string(&run.batches).unwrap()
}

fn cache_reuse_and_invalidation(store: &SessionStore) {
    let exp = expected();
    let tight_page = exp["tightTrio"]["page"].as_u64().unwrap() as u32;
    let loose_page = exp["looseTrio"]["page"].as_u64().unwrap() as u32;

    // A private copy: the test mutates it (never saved).
    let scratch = tempfile::tempdir().expect("tempdir");
    let path = scratch.path().join("book.pdf");
    std::fs::copy(fixture("book.pdf"), &path).unwrap();
    let doc = open_path(store, &path);

    let (bytes, cached, furniture) = cache_state(store, &doc, vec![0, tight_page]);
    assert_eq!(
        (bytes, cached, furniture),
        (0, vec![false, false], false),
        "cold"
    );

    // Identical searches are identical, cold or cached.
    let mut q = proximity("rescisão prazo indemnização", 500);
    q.exclude_headers_footers = true;
    let first = run(store, &doc, &q);
    let (bytes, cached, furniture) = cache_state(store, &doc, vec![0, tight_page, 39]);
    assert!(bytes > 0, "the index has a size after a search");
    assert_eq!(cached, [true, true, true], "every page was indexed");
    assert!(furniture, "header/footer detection cached");
    let second = run(store, &doc, &q);
    assert_eq!(serialized(&first), serialized(&second));
    assert_eq!(first.per_page().len(), 2);
    let (bytes_again, ..) = cache_state(store, &doc, vec![]);
    assert_eq!(bytes_again, bytes, "a cached run adds nothing");

    // Different options reuse the same cached indexes and agree with a cold run on another doc.
    let other = open_path(store, &fixture("book.pdf"));
    assert_eq!(serialized(&run(store, &other, &q)), serialized(&first));

    // Redact the tight trio (all three of its lines) through the session's commit path.
    let zone = first
        .hits()
        .into_iter()
        .find(|(p, _)| *p == tight_page)
        .unwrap()
        .1
        .window_rects
        .iter()
        .map(|w| w.rect.clone())
        .collect::<Vec<_>>();
    let result = store
        .with_session(&doc, move |s| {
            s.commit(Box::new(RedactCommand::new(tight_page, zone)))
        })
        .unwrap()
        .expect("redact_apply");
    assert!(result.invalidated_pages.contains(&tight_page));
    let (_, cached, furniture) = cache_state(store, &doc, vec![tight_page - 1, tight_page, 39]);
    assert_eq!(
        cached,
        [true, false, true],
        "only the redacted page's index is dropped"
    );
    assert!(!furniture, "any invalidation drops header/footer detection");

    let r = run(store, &doc, &q);
    check_batch_rules(&r, SearchMode::Proximity, 0);
    assert_eq!(
        r.hits().iter().map(|(p, _)| *p).collect::<Vec<_>>(),
        [loose_page],
        "the redacted trio is gone; a stale index would still find it"
    );
    let (_, cached, furniture) = cache_state(store, &doc, vec![tight_page]);
    assert_eq!(
        (cached, furniture),
        (vec![true], true),
        "re-indexed on demand"
    );
    assert_eq!(
        run(store, &doc, &phrase("indemnização"))
            .per_page()
            .keys()
            .copied()
            .collect::<Vec<_>>(),
        [loose_page, 37],
        "the plain term is gone from the redacted page as well"
    );

    // Undo restores the text, and the search sees it again.
    store
        .with_session(&doc, |s| s.undo())
        .unwrap()
        .expect("undo")
        .expect("something to undo");
    let r = run(store, &doc, &q);
    // (Undo re-creates the removed objects, so char indexes/rects may differ from the original
    // page; the zone itself must be back.)
    let zones = |r: &Run| -> Vec<(u32, Option<u32>, String, Option<String>)> {
        r.hits()
            .into_iter()
            .map(|(p, h)| {
                (
                    p,
                    h.score,
                    h.context.matched.clone(),
                    h.outline_item_id.clone(),
                )
            })
            .collect()
    };
    assert_eq!(zones(&r), zones(&first), "undo brings the trio back");

    // A structural change (page count) clears the whole cache.
    store
        .with_session(&doc, |s| {
            s.commit(Box::new(InsertBlankPageCommand::new(612.0, 792.0)))
        })
        .unwrap()
        .expect("insert page");
    let (bytes, cached, furniture) = cache_state(store, &doc, vec![0, tight_page]);
    assert_eq!((bytes, cached, furniture), (0, vec![false, false], false));
    let r = run(store, &doc, &q);
    assert_eq!(
        r.done().page_count,
        41,
        "the new blank page is searched too"
    );
    assert_eq!(r.hits().len(), 2);
}

#[test]
fn search_v2_pipeline() {
    init_journal_dir();
    let store = SessionStore::default();

    let mut failures: Vec<&str> = Vec::new();
    macro_rules! case {
        ($name:ident) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $name(&store))).is_err() {
                failures.push(stringify!($name));
            }
        };
    }

    case!(phrase_contrato_whole_word_on_book);
    case!(phrase_options_widen_and_narrow_results);
    case!(proximity_windows_scopes_and_ranking);
    case!(prepare_rejects_bad_arguments);
    case!(exclude_headers_footers_and_furniture);
    case!(ignore_diacritics_finds_the_acao_pages);
    case!(progress_every_25_pages_on_500_pages);
    case!(textless_documents);
    case!(cancellation);
    case!(cache_reuse_and_invalidation);

    assert!(failures.is_empty(), "failing sub-tests: {failures:#?}");
}
