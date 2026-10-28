//! S5: running header/footer detection (`engine::search::furniture`) against the real fixtures.
//!
//! Real input: each page is read the way production reads it — `extract::extract_page` inside
//! `SessionStore::with_session` (the only place PDFium may run) and `RawPage::page_lines()`
//! collected out. `furniture::detect` itself is pure Rust and runs on the test thread.
//!
//! As in `engine_fixtures.rs` all checks run sequentially from one `#[test]` function, so the
//! vendored PDFium build only ever sees a single thread identity.
//!
//! The measured positions of every fixture's header/footer are printed (`--nocapture`):
//! cargo test --manifest-path src-tauri/Cargo.toml --test search_v2_furniture -- --nocapture

use std::path::PathBuf;
use std::time::Instant;

use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::search::furniture::{detect, Furniture};
use rubrica_lib::engine::search::{extract, PageLines};
use rubrica_lib::types::DocId;
use serde_json::Value;

fn fixture(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "..", "fixtures", name]
        .iter()
        .collect()
}

fn open(store: &SessionStore, name: &str) -> DocId {
    let path = fixture(name).to_str().unwrap().to_owned();
    store
        .with_store(move |sessions| {
            let session = DocumentSession::open(&path).expect("open fixture");
            let id = session.id().clone();
            sessions.insert(id.clone(), session);
            id
        })
        .unwrap()
}

/// Every page's lines, extracted on the PDFium owner thread.
fn page_lines(store: &SessionStore, doc: &DocId) -> Vec<PageLines> {
    store
        .with_session(doc, |session| {
            let pages = session.document().pages();
            (0..pages.len() as u32)
                .map(|n| {
                    let page = pages.get(n as i32).expect("page");
                    extract::extract_page(&page, n).page_lines()
                })
                .collect()
        })
        .unwrap()
}

fn expected() -> Value {
    let raw = std::fs::read_to_string(fixture("book.expected.json")).expect("book.expected.json");
    serde_json::from_str(&raw).expect("valid JSON")
}

fn squash(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The text and rect of every excluded line of `page`.
fn excluded(pages: &[PageLines], furniture: &Furniture, page: u32) -> Vec<(String, f32, f32)> {
    let lines = &pages[page as usize].lines;
    furniture
        .lines(page)
        .iter()
        .map(|f| {
            let line = lines
                .iter()
                .find(|l| l.chars == f.chars)
                .expect("an excluded range is a line of the page");
            assert_eq!(line.rect, f.rect, "page {page}: rect of an excluded line");
            (squash(&line.text), f.rect.y, f.rect.top())
        })
        .collect()
}

fn no_furniture(name: &str, pages: &[PageLines]) {
    let f = detect(pages);
    for p in pages {
        assert!(
            f.lines(p.page).is_empty(),
            "{name} page {}: unexpected furniture {:?}",
            p.page,
            excluded(pages, &f, p.page)
        );
        assert!(f.page_furniture(p.page).is_none());
        assert!(f.excluded_ranges(p.page).is_empty());
    }
}

/// Prints where the lines of the first interesting pages sit, to document the band choice.
fn report_positions(name: &str, pages: &[PageLines], which: &[usize]) {
    for &i in which {
        let p = &pages[i];
        let band = p.height * 0.08;
        for l in &p.lines {
            let tag = if l.rect.top() > p.height - band {
                "TOP-BAND"
            } else if l.rect.y < band {
                "BOTTOM-BAND"
            } else {
                "body"
            };
            println!(
                "[{name}] page {i} h={} band={:.1}  y={:.1}..{:.1}  {tag:11}  {:?}",
                p.height,
                band,
                l.rect.y,
                l.rect.top(),
                squash(&l.text).chars().take(40).collect::<String>()
            );
        }
    }
}

fn check_book(store: &SessionStore, name: &str, pages: &[PageLines]) {
    let exp = expected();
    let count = exp["pageCount"].as_u64().unwrap() as usize;
    assert_eq!(pages.len(), count);
    let header = &exp["header"];
    let footer = &exp["footer"];
    let first = header["firstPage"].as_u64().unwrap() as u32;
    assert_eq!(footer["firstPage"].as_u64().unwrap() as u32, first);
    let header_y = header["baselineY"].as_f64().unwrap() as f32;
    let footer_y = footer["baselineY"].as_f64().unwrap() as f32;
    let pattern = footer["pattern"].as_str().unwrap();
    let _ = store;

    let furniture = detect(pages);
    let mut total_excluded = 0;
    for p in pages {
        let got = excluded(pages, &furniture, p.page);
        total_excluded += got.len();
        if p.page < first {
            assert!(got.is_empty(), "{name} page {}: {got:?}", p.page);
            continue;
        }
        assert_eq!(got.len(), 2, "{name} page {}: {got:?}", p.page);
        let want_header = header["byPage"][p.page.to_string()]
            .as_str()
            .unwrap_or_else(|| panic!("expected header for page {}", p.page));
        let want_footer = pattern.replace("{n}", &(p.page + 1).to_string());
        let mut by_pos = got.clone();
        by_pos.sort_by(|a, b| b.1.total_cmp(&a.1));
        assert_eq!(by_pos[0].0, squash(want_header), "{name} page {}", p.page);
        assert_eq!(by_pos[1].0, squash(&want_footer), "{name} page {}", p.page);
        // The excluded rects sit on the documented baselines (within the glyph box).
        assert!(
            by_pos[0].1 <= header_y + 1.0 && by_pos[0].2 >= header_y,
            "{name} page {}: header rect {:?} vs baseline {header_y}",
            p.page,
            by_pos[0]
        );
        assert!(
            by_pos[1].1 <= footer_y + 1.0 && by_pos[1].2 >= footer_y,
            "{name} page {}: footer rect {:?} vs baseline {footer_y}",
            p.page,
            by_pos[1]
        );
        // `excluded_ranges` and `page_furniture` mirror `lines`.
        let ranges = furniture.excluded_ranges(p.page);
        assert_eq!(ranges.len(), 2);
        let pf = furniture.page_furniture(p.page).expect("furniture entry");
        assert_eq!(pf.page, p.page);
        assert_eq!(pf.rects.len(), 2);
        for (rect, line) in pf.rects.iter().zip(furniture.lines(p.page)) {
            assert_eq!(rect.x, line.rect.x as f64);
            assert_eq!(rect.y, line.rect.y as f64);
            assert_eq!(rect.width, line.rect.w as f64);
            assert_eq!(rect.height, line.rect.h as f64);
        }
    }
    assert_eq!(total_excluded, 2 * (count - first as usize));
    println!("[{name}] {total_excluded} furniture lines over {count} pages");
}

#[test]
fn furniture_against_the_fixtures() {
    std::env::set_var(
        "RUBRICA_JOURNAL_DIR",
        std::env::temp_dir().join(format!("rubrica-furniture-journal-{}", std::process::id())),
    );
    let store = SessionStore::default();

    // book.pdf and its outline-less twin: every page 2-40 has the expected header and footer,
    // page 1 has none, and no body line is excluded.
    let book_id = open(&store, "book.pdf");
    let book = page_lines(&store, &book_id);
    report_positions("book", &book, &[0, 1, 2]);
    check_book(&store, "book.pdf", &book);

    let twin_id = open(&store, "book-no-outline.pdf");
    let twin = page_lines(&store, &twin_id);
    check_book(&store, "book-no-outline.pdf", &twin);
    let (a, b) = (detect(&book), detect(&twin));
    for n in 0..40 {
        assert_eq!(a.lines(n), b.lines(n), "same furniture on both books");
    }

    // No false positives on the small fixtures.
    for name in ["text.pdf", "unicode.pdf", "form.pdf"] {
        let id = open(&store, name);
        let pages = page_lines(&store, &id);
        report_positions(name, &pages, &[0]);
        no_furniture(name, &pages);
    }

    // 500-page.pdf: "Page N of 500" is furniture on every page.
    let id = open(&store, "500-page.pdf");
    let big = page_lines(&store, &id);
    assert_eq!(big.len(), 500);
    report_positions("500-page", &big, &[0, 499]);
    let started = Instant::now();
    let furniture = detect(&big);
    let elapsed = started.elapsed();
    println!("[500-page] detect over 500 pages: {elapsed:?}");
    for p in &big {
        let got = excluded(&big, &furniture, p.page);
        assert_eq!(got.len(), 1, "page {}: {got:?}", p.page);
        assert_eq!(got[0].0, format!("Page {} of 500", p.page + 1));
    }
    assert!(elapsed.as_millis() < 500, "detect took {elapsed:?}");
}
