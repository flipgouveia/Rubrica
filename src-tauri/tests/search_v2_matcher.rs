//! S3: phrase / proximity matching on `fixtures/book.pdf` (search v2), with
//! `fixtures/book.expected.json` as the ground truth.
//!
//! Pages are extracted through `extract::extract_page` inside `SessionStore::with_session`; the
//! matching itself is pure Rust over `PageIndex`es on the test thread, exactly as the search task
//! will run it. All sub-tests run from one `#[test]` sharing one `SessionStore` (see
//! `search_engine.rs`: the vendored PDFium build must only ever see one owner thread).
//!
//! `book.expected.json` page keys are 0-based page indexes (`page`), not the 1-based labels the
//! README tables use.

use std::collections::BTreeMap;
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Once};
use std::time::Instant;

use pdfium_render::prelude::*;
use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::search::extract;
use rubrica_lib::engine::search::index::PageIndex;
use rubrica_lib::engine::search::matcher::{compile, rank, FoundHit, Matcher};
use rubrica_lib::engine::search::{BoxF, RawChar, RawPage};
use rubrica_lib::types::{ProximityOptions, SearchMode, SearchQuery, SearchScope};
use serde_json::Value;

static INIT: Once = Once::new();

fn init_journal_dir() {
    INIT.call_once(|| {
        let dir =
            std::env::temp_dir().join(format!("rubrica-search-v2-matcher-{}", std::process::id()));
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

fn open(store: &SessionStore, path: &Path) -> String {
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

fn extract_all(store: &SessionStore, doc: &str) -> Vec<RawPage> {
    store
        .with_session(doc, |s| {
            let pages = s.document().pages();
            (0..pages.len())
                .map(|i| {
                    let page = pages.get(i as PdfPageIndex).expect("page");
                    extract::extract_page(&page, i as u32)
                })
                .collect::<Vec<_>>()
        })
        .expect("extract")
}

fn expected() -> Value {
    let raw = std::fs::read_to_string(fixture("book.expected.json")).expect("book.expected.json");
    serde_json::from_str(&raw).expect("valid JSON")
}

// --- query helpers ---------------------------------------------------------------------------------

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

fn prox(text: &str, window: u32) -> SearchQuery {
    SearchQuery {
        mode: SearchMode::Proximity,
        proximity: Some(ProximityOptions { window }),
        ..phrase(text)
    }
}

fn whole(mut q: SearchQuery) -> SearchQuery {
    q.whole_word = true;
    q
}

/// A loaded document: raw pages (for furniture), their indexes (for matching).
struct Book {
    raw: Vec<RawPage>,
    index: Vec<Arc<PageIndex>>,
}

impl Book {
    fn load(store: &SessionStore, name: &str) -> Book {
        let doc = open(store, &fixture(name));
        let raw = extract_all(store, &doc);
        let index = raw
            .iter()
            .map(|r| Arc::new(PageIndex::from_raw(r)))
            .collect();
        Book { raw, index }
    }

    /// The known running headers/footers of `book.pdf`: lines inside the top / bottom 8 % band.
    fn furniture(&self, page: usize) -> Vec<Range<u32>> {
        let raw = &self.raw[page];
        raw.lines
            .iter()
            .filter(|l| l.rect.y >= raw.height * 0.92 || l.rect.top() <= raw.height * 0.08)
            .map(|l| l.chars.clone())
            .collect()
    }

    /// Streams `pages` (consecutive or not) through a matcher.
    fn search(&self, q: &SearchQuery, pages: Range<usize>, exclude: bool) -> Vec<FoundHit> {
        let mut m = Matcher::new(Arc::new(compile(q).expect("valid query")));
        let mut out = Vec::new();
        for p in pages {
            let ex = if exclude {
                self.furniture(p)
            } else {
                Vec::new()
            };
            out.extend(m.push_page(Arc::clone(&self.index[p]), &ex));
        }
        out.extend(m.finish());
        out
    }

    fn all(&self, q: &SearchQuery) -> Vec<FoundHit> {
        self.search(q, 0..self.index.len(), false)
    }
}

fn by_page(hits: &[FoundHit]) -> BTreeMap<u32, usize> {
    let mut m = BTreeMap::new();
    for h in hits {
        *m.entry(h.page).or_insert(0) += 1;
    }
    m
}

fn pages_of(hits: &[FoundHit]) -> Vec<u32> {
    hits.iter().map(|h| h.page).collect()
}

fn json_pages(v: &Value) -> BTreeMap<u32, usize> {
    v.as_object()
        .map(|o| {
            o.iter()
                .map(|(k, n)| (k.parse().unwrap(), n.as_u64().unwrap() as usize))
                .collect()
        })
        .unwrap_or_default()
}

// --- tests ---------------------------------------------------------------------------------------

/// Whole-word "contrato" per page = body + titles (+ the word split by the line-end hyphen,
/// which the fixture does not count in its totals but this matcher must find).
fn whole_word_contrato_matches_the_expected_counts(book: &Book) {
    let exp = expected();
    let body = json_pages(&exp["contrato"]["byPage"]);
    let headings = json_pages(&exp["contratoInTitles"]["headings"]["byPage"]);
    let headers = json_pages(&exp["contratoInTitles"]["headers"]["byPage"]);
    let hyph_page = exp["hyphenated"]["contrato"]["page"].as_u64().unwrap() as u32;

    let mut want: BTreeMap<u32, usize> = BTreeMap::new();
    for (p, n) in body.iter().chain(&headings).chain(&headers) {
        *want.entry(*p).or_insert(0) += n;
    }
    *want.entry(hyph_page).or_insert(0) += 1;

    let mut q = whole(phrase("contrato"));
    q.case_sensitive = true;
    let hits = book.all(&q);
    assert_eq!(
        by_page(&hits),
        want,
        "per-page whole-word 'contrato' (case-sensitive)"
    );
    let total = body.values().sum::<usize>()
        + headings.values().sum::<usize>()
        + headers.values().sum::<usize>()
        + 1;
    assert_eq!(hits.len(), total);
    assert_eq!(hits.len(), 189 + 10 + 1);

    // Case-insensitive finds at least those (a capitalized "Contrato" would add more).
    let ci = book.all(&whole(phrase("CONTRATO")));
    assert!(ci.len() >= hits.len());
    // Every hit carries a rect for the word on its own page.
    for h in &hits {
        assert!(!h.hit.rects.is_empty());
        assert!(h.hit.rects.iter().all(|r| r.page == h.page));
    }
    // With headers/footers excluded the 8 running headers with the word disappear.
    let ex = book.search(&q, 0..book.index.len(), true);
    assert_eq!(ex.len(), total - headers.values().sum::<usize>());
}

fn scope_is_whatever_pages_are_pushed(book: &Book) {
    let q = whole(phrase("contrato"));
    let all = by_page(&book.all(&q));
    let part = by_page(&book.search(&q, 10..20, false));
    let want: BTreeMap<u32, usize> = all
        .into_iter()
        .filter(|(p, _)| (10..20).contains(p))
        .collect();
    assert_eq!(part, want);
}

fn tight_and_loose_trios(book: &Book) {
    let exp = expected();
    for (zone, text_form) in [
        ("tightTrio", "rescisão prazo indemnização"),
        ("looseTrio", "rescisao prazo indemnizacao"),
    ] {
        let page = exp[zone]["page"].as_u64().unwrap() as u32;
        let span = exp[zone]["spanChars"].as_u64().unwrap() as u32;
        for window in [100u32, 250, 500] {
            let found = exp[zone]["foundWithWindow"][window.to_string()]
                .as_bool()
                .unwrap();
            for text in [text_form, "rescisão prazo indemnização"] {
                let hits = book.all(&prox(text, window));
                let on_zone: Vec<&FoundHit> = hits.iter().filter(|h| h.page == page).collect();
                assert_eq!(
                    !on_zone.is_empty(),
                    found,
                    "{zone} window {window} ({text})"
                );
                if found {
                    assert_eq!(on_zone.len(), 1);
                    let h = &on_zone[0].hit;
                    assert_eq!(h.score, Some(span), "{zone}: window length");
                    assert_eq!(
                        h.rects.iter().map(|r| r.term).collect::<Vec<_>>(),
                        vec![0, 1, 2],
                        "one rect per term, in text order, term = query position"
                    );
                    assert!(!h.window_rects.is_empty());
                    assert_eq!(h.spans_pages, None);
                    if span < 160 {
                        assert_eq!(h.context.terms.len(), 3);
                    } else {
                        // 386 chars: the middle term sits in the elided middle of `matched`
                        let terms: Vec<u8> = h.context.terms.iter().map(|t| t.term).collect();
                        assert_eq!(terms, vec![0, 2], "{zone}");
                        assert!(h.context.matched.contains(" … "));
                    }
                }
            }
        }
    }

    // The window lengths of both zones, found together at 500, ranked by compactness.
    let mut hits = book.all(&prox("rescisão prazo indemnização", 500));
    assert_eq!(
        hits.len(),
        2,
        "tight trio and loose trio only: {:?}",
        pages_of(&hits)
    );
    hits.reverse();
    rank(&mut hits);
    assert_eq!(
        hits.iter()
            .map(|h| (h.page, h.hit.score.unwrap()))
            .collect::<Vec<_>>(),
        vec![(16, 125), (29, 386)]
    );
    println!("tight trio window = 125 chars, loose trio window = 386 chars (expected 125 / 386)");

    // Windows are minimal: the loose trio's five lines give three rects + window rects per line.
    let loose = &hits[1].hit;
    assert_eq!(loose.window_rects.len(), 5, "the window crosses five lines");
}

/// The decoys sit on pages 33 and 37 (0-based), ~3,560 chars apart but four pages away from
/// each other. The brief allows a window to continue onto the NEXT page only, so by design they
/// can never be joined, even with the largest window; what does happen is that each decoy term
/// stays alone and is not a hit.
fn decoy_terms_are_never_joined(book: &Book) {
    let exp = expected();
    let between = exp["decoy"]["charsBetween"].as_u64().unwrap();
    assert!(500 < between && between < 5000);
    let p1 = exp["decoy"]["rescisao"]["page"].as_u64().unwrap() as u32;
    let p2 = exp["decoy"]["indemnizacao"]["page"].as_u64().unwrap() as u32;
    assert!(p2 - p1 > 1, "not adjacent pages");
    for window in [500u32, 5000] {
        let hits = book.all(&prox("rescisão indemnização", window));
        let pages = pages_of(&hits);
        assert!(
            !pages.contains(&p1) && !pages.contains(&p2),
            "{window}: {pages:?}"
        );
        assert!(hits.iter().all(|h| h.hit.spans_pages.is_none()));
        // only the two trio zones qualify (rescisão + indemnização within one page)
        assert_eq!(pages, vec![16, 29], "window {window}");
    }
    // Each decoy term alone is found as a one-term window.
    assert_eq!(pages_of(&book.all(&prox("rescisão", 20))), vec![16, 29, p1]);
    assert_eq!(
        pages_of(&book.all(&prox("indemnização", 20))),
        vec![16, 29, p2]
    );
    // A one-page span of the carry rule does work: p.33 + p.34 would be reachable. Page 34 is
    // short and empty of both terms, so the pair still has no hit.
    assert!(book
        .search(&prox("rescisão indemnização", 5000), 32..36, false)
        .is_empty());
}

fn cross_page_phrase(book: &Book) {
    let exp = expected();
    let from = exp["crossPage"]["fromPage"].as_u64().unwrap() as usize;
    let to = exp["crossPage"]["toPage"].as_u64().unwrap() as usize;
    assert_eq!(to, from + 1);
    let text = exp["crossPage"]["phrase"].as_str().unwrap();

    // Exclusion on: footer of p.22 and header of p.23 are absent, the phrase joins.
    let hits = book.search(&phrase(text), from - 1..to + 2, true);
    assert_eq!(hits.len(), 1, "{:?}", pages_of(&hits));
    let h = &hits[0];
    assert_eq!(h.page as usize, from);
    assert_eq!(h.hit.spans_pages, Some((from as u32, to as u32)));
    assert_eq!(h.hit.context.matched, text);
    let rect_pages: Vec<u32> = h.hit.rects.iter().map(|r| r.page).collect();
    assert_eq!(rect_pages, vec![from as u32, to as u32]);
    assert_eq!(
        h.hit.char_start + h.hit.char_len,
        book.index[from].char_count(),
        "charLen stops at the start page's end"
    );
    // Footer and header text never appear in the context.
    assert!(!h.hit.context.before.contains("Página") && !h.hit.context.after.contains("Página"));

    // Exclusion off: "Página 22 de 40" and the header sit between the halves.
    assert!(book
        .search(&phrase(text), from - 1..to + 2, false)
        .is_empty());

    // The same boundary as a proximity window: counted without the furniture when excluded.
    // (whole word: "necessário" contains "cessar" once accents are folded)
    let q = whole(prox("cessar acordo", 40));
    let with = book.search(&q, from - 1..to + 2, true);
    assert_eq!(with.len(), 1);
    assert_eq!(with[0].hit.score, Some("cessar o acordo".len() as u32));
    assert_eq!(with[0].hit.spans_pages, Some((from as u32, to as u32)));
    assert!(
        book.search(&q, from - 1..to + 2, false).is_empty(),
        "footer + header exceed 40"
    );
    let long = book.search(&whole(prox("cessar acordo", 200)), from - 1..to + 2, false);
    assert_eq!(long.len(), 1);
    assert!(
        long[0].hit.score.unwrap() > 15 + 15 + 5,
        "footer and header are counted"
    );
}

fn hyphen_zone(book: &Book) {
    let exp = expected();
    let page = exp["hyphenated"]["contrato"]["page"].as_u64().unwrap() as u32;
    // "contra-⏎to": with and without the hyphen
    let hits = book.all(&phrase("contra-to"));
    assert_eq!(pages_of(&hits), vec![page]);
    assert_eq!(hits[0].hit.rects.len(), 2, "one rect per line");
    assert_eq!(hits[0].hit.context.matched, "contra-to");
    // "contrato" on that page: the body count plus the split word.
    let body = json_pages(&exp["contrato"]["byPage"])
        .get(&page)
        .copied()
        .unwrap_or(0);
    let on_page = |q: &SearchQuery| book.all(q).iter().filter(|h| h.page == page).count();
    assert_eq!(on_page(&whole(phrase("contrato"))), body + 1);
    // "pré-⏎aviso": hyphenated, joined and accent-folded forms all find it, once, on that page.
    for text in [
        "pré-aviso",
        "préaviso",
        "pre-aviso",
        "preaviso",
        "PRÉ-AVISO",
    ] {
        let hits = book.all(&phrase(text));
        assert_eq!(pages_of(&hits), vec![page], "{text}");
        assert_eq!(hits[0].hit.rects.len(), 2);
    }
    // a space is not a hyphen
    assert!(book.all(&phrase("pré aviso")).is_empty());
    assert!(book.all(&phrase("contra to")).is_empty());
    // the hit text reads as on the page
    let h = &book.all(&phrase("pré-aviso"))[0].hit;
    assert_eq!(h.context.matched, "pré-aviso");
    assert!(
        h.context.before.ends_with("final do "),
        "{:?}",
        h.context.before
    );
    assert!(
        h.context.after.starts_with(" acordado"),
        "{:?}",
        h.context.after
    );

    // soft hyphen (also U+0002 in PDFium)
    let sp = exp["softHyphen"]["page"].as_u64().unwrap() as u32;
    let hits = book.all(&phrase("obrigações"));
    assert_eq!(pages_of(&hits), vec![sp]);
    assert_eq!(book.all(&phrase("obrigacoes")).len(), 1);
    assert_eq!(book.all(&whole(phrase("obrigações"))).len(), 1);
}

fn ligatures_quotes_nbsp(book: &Book) {
    let exp = expected();
    let lp = exp["ligatures"]["page"].as_u64().unwrap() as u32;
    for text in [
        "eficácia",
        "eficacia",
        "eﬁcácia",
        "fluxo",
        "ﬂuxo",
        "eficácia do mecanismo",
    ] {
        assert_eq!(pages_of(&book.all(&phrase(text))), vec![lp], "{text}");
    }
    let qp = exp["quotesNbsp"]["page"].as_u64().unwrap() as u32;
    for text in [
        "\"justa causa\"",
        "“justa causa”",
        "justa causa",
        "art. 12.º",
        "art.\u{A0}12.º",
    ] {
        assert_eq!(pages_of(&book.all(&phrase(text))), vec![qp], "{text}");
    }
}

fn accent_insensitive_acao(book: &Book) {
    let exp = expected();
    let want = json_pages(&exp["acaoByPage"]);
    for text in ["acao", "ação", "AÇÃO", "Acao"] {
        let hits = book.all(&whole(phrase(text)));
        assert_eq!(by_page(&hits), want, "whole-word {text}");
    }
    // not whole word: the many "-ação" words show up too, on top of the standalone ones
    let loose = by_page(&book.all(&phrase("acao")));
    assert!(loose.values().sum::<usize>() > 50);
    for (p, n) in &want {
        assert!(loose.get(p).copied().unwrap_or(0) >= *n);
    }
    // accents significant: "acao" finds nothing, "ação" the same pages as before
    let mut q = whole(phrase("acao"));
    q.ignore_diacritics = false;
    assert!(book.all(&q).is_empty());
    q.text = "ação".into();
    assert_eq!(by_page(&book.all(&q)), want);
    // case sensitive "Ação" does not exist, "ação" does
    let mut q = whole(phrase("Ação"));
    q.case_sensitive = true;
    q.ignore_diacritics = false;
    assert!(book.all(&q).is_empty());
    q.text = "ação".into();
    assert_eq!(by_page(&book.all(&q)), want);
}

fn proximity_ranking_and_spans(book: &Book) {
    let mut hits = book.all(&prox("contrato prazo", 500));
    assert!(hits.len() > 5);
    rank(&mut hits);
    let scores: Vec<u32> = hits.iter().map(|h| h.hit.score.unwrap()).collect();
    assert!(
        scores.windows(2).all(|w| w[0] <= w[1]),
        "sorted by compactness"
    );
    assert!(scores.iter().all(|&s| s <= 500));
    // no two windows overlap on the same page
    let mut by: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
    for h in &hits {
        by.entry(h.page)
            .or_default()
            .push((h.hit.char_start, h.hit.char_len));
    }
    for (p, mut spans) in by {
        spans.sort();
        for w in spans.windows(2) {
            assert!(w[0].0 + w[0].1 <= w[1].0, "overlap on page {p}: {w:?}");
        }
    }
}

/// 500-page.pdf: one "Page N of 500" per page; a streaming run over 500 pushed pages.
fn five_hundred_pages(store: &SessionStore) {
    let book = Book::load(store, "500-page.pdf");
    assert_eq!(book.index.len(), 500);
    let t = Instant::now();
    let hits = book.all(&phrase("of 500"));
    println!(
        "500-page.pdf phrase 'of 500': {} hits in {:.2?}",
        hits.len(),
        t.elapsed()
    );
    assert_eq!(hits.len(), 500);
    assert_eq!(pages_of(&hits), (0..500).collect::<Vec<u32>>());

    let hits = book.all(&phrase("Page 250 of 500"));
    assert_eq!(pages_of(&hits), vec![249]);

    // "Page" is on every page, "250" only on page 249: the minimal window is the one on page 249
    // (the windows reaching back to p.248's "Page" or forward to p.250's contain it / overlap it
    // and are longer).
    let t = Instant::now();
    let hits = book.all(&prox("Page 250", 20));
    println!(
        "500-page.pdf proximity 'Page 250': {} hits in {:.2?}",
        hits.len(),
        t.elapsed()
    );
    assert_eq!(pages_of(&hits), vec![249]);
    assert_eq!(hits[0].hit.score, Some("Page 250".len() as u32));

    // "of 500" then next page's "Page": crosses every page break, 499 windows in total.
    let hits = book.all(&prox("500 Page", 20));
    assert_eq!(hits.len(), 499);
    assert!(hits
        .iter()
        .all(|h| h.hit.spans_pages == Some((h.page, h.page + 1))));
    assert!(hits
        .iter()
        .all(|h| h.hit.score == Some("500 Page".len() as u32)));
}

/// A synthetic 500 × 4000-char document: how long matching takes (printed, loosely bounded).
fn synthetic_performance() {
    const WORDS: [&str; 12] = [
        "contrato",
        "ação",
        "rescisão",
        "prazo",
        "parte",
        "notificação",
        "cláusula",
        "a",
        "de",
        "o",
        "indemnização",
        "fixando",
    ];
    let t = Instant::now();
    let indexes: Vec<Arc<PageIndex>> = (0..500u32)
        .map(|p| {
            let mut chars = Vec::new();
            let (mut x, mut y) = (36.0f32, 740.0f32);
            let mut w = (p as usize * 7) % WORDS.len();
            while chars.len() < 4000 {
                for c in WORDS[w].chars().chain([' ']) {
                    chars.push(RawChar {
                        ch: c,
                        bbox: Some(BoxF {
                            x,
                            y,
                            w: 5.0,
                            h: 10.0,
                        }),
                        generated: false,
                    });
                    x += 5.5;
                }
                w = (w + 5) % WORDS.len();
                if x > 540.0 {
                    x = 36.0;
                    y -= 11.0;
                    for b in ['\r', '\n'] {
                        chars.push(RawChar {
                            ch: b,
                            bbox: None,
                            generated: true,
                        });
                    }
                }
            }
            let lines = extract::group_lines(&chars);
            let raw = RawPage {
                page: p,
                width: 612.0,
                height: 792.0,
                chars,
                lines,
            };
            Arc::new(PageIndex::from_raw(&raw))
        })
        .collect();
    println!("synthetic 500x4000: indexes built in {:.2?}", t.elapsed());

    let run = |q: &SearchQuery| {
        let t = Instant::now();
        let mut m = Matcher::new(Arc::new(compile(q).unwrap()));
        let mut n = 0;
        for idx in &indexes {
            n += m.push_page(Arc::clone(idx), &[]).len();
        }
        n += m.finish().len();
        (n, t.elapsed())
    };
    let (n, d) = run(&whole(phrase("contrato")));
    println!("synthetic phrase 'contrato' (whole word): {n} hits in {d:.2?}");
    assert!(n > 100);
    let (n, d) = run(&phrase("acao"));
    println!("synthetic phrase 'acao' (accent-insensitive): {n} hits in {d:.2?}");
    assert!(n > 100);
    let mut strict = phrase("Contrato");
    strict.case_sensitive = true;
    let (n, d) = run(&strict);
    println!("synthetic phrase 'Contrato' (case-sensitive, verified): {n} hits in {d:.2?}");
    assert_eq!(n, 0);
    let (n, d) = run(&prox("contrato rescisão prazo", 500));
    println!("synthetic proximity 'contrato rescisão prazo' (500): {n} hits in {d:.2?}");
    assert!(n > 100);
    assert!(d.as_secs() < 60, "{d:?}");
}

/// Same fixtures/queries as the phase-1 baseline recorded in `search_perf.rs`, for the §2.2 budget: "first" is
/// extraction (one PDFium hop per page, as the pipeline will do) + index build + matching,
/// "cached" is matching over the cached indexes only.
///
/// cargo test --manifest-path src-tauri/Cargo.toml --release --test search_v2_matcher -- --ignored --nocapture
#[test]
#[ignore = "perf numbers, run on demand"]
fn search_v2_perf_vs_phase1() {
    init_journal_dir();
    let store = SessionStore::default();
    for (name, query) in [
        ("book.pdf", "contrato"),
        ("500-page.pdf", "page"),
        ("text.pdf", "the"),
    ] {
        let doc = open(&store, &fixture(name));
        let q = phrase(query);
        let t = Instant::now();
        let count = store
            .with_session(&doc, |s| s.document().pages().len())
            .unwrap() as u32;
        let mut indexes = Vec::new();
        let mut m = Matcher::new(Arc::new(compile(&q).unwrap()));
        let mut hits = 0;
        for p in 0..count {
            let raw = store
                .with_session(&doc, move |s| {
                    let page = s.document().pages().get(p as PdfPageIndex).unwrap();
                    extract::extract_page(&page, p)
                })
                .unwrap();
            let idx = Arc::new(PageIndex::from_raw(&raw));
            hits += m.push_page(Arc::clone(&idx), &[]).len();
            indexes.push(idx);
        }
        hits += m.finish().len();
        let first = t.elapsed();
        let t = Instant::now();
        let mut m = Matcher::new(Arc::new(compile(&q).unwrap()));
        let mut again = 0;
        for idx in &indexes {
            again += m.push_page(Arc::clone(idx), &[]).len();
        }
        again += m.finish().len();
        let cached = t.elapsed();
        assert_eq!(hits, again);
        println!(
            "v2     {name:14} {query:9} hits={hits:5} first={:7.1}ms cached={:7.1}ms",
            first.as_secs_f64() * 1000.0,
            cached.as_secs_f64() * 1000.0
        );
    }
}

#[test]
fn search_v2_matcher_on_book_pdf() {
    init_journal_dir();
    let store = SessionStore::default();
    let book = Book::load(&store, "book.pdf");
    assert_eq!(book.index.len(), 40);

    let mut failures: Vec<&str> = Vec::new();
    macro_rules! case {
        ($name:ident($($arg:expr),*)) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $name($($arg),*))).is_err()
            {
                failures.push(stringify!($name));
            }
        };
    }

    case!(whole_word_contrato_matches_the_expected_counts(&book));
    case!(scope_is_whatever_pages_are_pushed(&book));
    case!(tight_and_loose_trios(&book));
    case!(decoy_terms_are_never_joined(&book));
    case!(cross_page_phrase(&book));
    case!(hyphen_zone(&book));
    case!(ligatures_quotes_nbsp(&book));
    case!(accent_insensitive_acao(&book));
    case!(proximity_ranking_and_spans(&book));
    case!(five_hundred_pages(&store));
    case!(synthetic_performance());

    assert!(failures.is_empty(), "failing sub-tests: {failures:#?}");
}
