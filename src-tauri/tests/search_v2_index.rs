//! S3: `PageIndex` against real PDFium pages (search v2).
//!
//! Pages are extracted with `extract::extract_page` inside `SessionStore::with_session` (the only
//! PDFium access, on the owner thread, like production); everything after that is pure Rust on
//! the test thread. As in `search_engine.rs` all sub-tests run from one `#[test]` sharing one
//! `SessionStore`, so the vendored PDFium build only ever sees one owner thread.

use std::path::{Path, PathBuf};
use std::sync::Once;
use std::time::Instant;

use pdfium_render::prelude::*;
use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::search::extract;
use rubrica_lib::engine::search::index::PageIndex;
use rubrica_lib::engine::search::normalize::HY;
use rubrica_lib::engine::search::{BoxF, RawChar, RawPage};
use serde_json::Value;

static INIT: Once = Once::new();

fn init_journal_dir() {
    INIT.call_once(|| {
        let dir =
            std::env::temp_dir().join(format!("rubrica-search-v2-index-{}", std::process::id()));
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

/// Every page of `doc`, extracted on the owner thread.
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

fn norm_string(idx: &PageIndex) -> String {
    String::from_utf16_lossy(
        &idx.norm()
            .iter()
            .map(|&u| if u == HY { b'~' as u16 } else { u })
            .collect::<Vec<_>>(),
    )
}

// --- tests ---------------------------------------------------------------------------------------

/// `line_texts()` must equal `RawPage::line_texts()` on real pages of several fixtures; counts and
/// the textless flag agree with the raw page.
fn line_texts_and_counts_match_the_raw_pages(store: &SessionStore) {
    let mut total_lines = 0;
    for name in [
        "book.pdf",
        "text.pdf",
        "unicode.pdf",
        "500-page.pdf",
        "form.pdf",
    ] {
        let doc = open(store, &fixture(name));
        for raw in extract_all(store, &doc) {
            let idx = PageIndex::from_raw(&raw);
            assert_eq!(
                idx.line_texts(),
                raw.line_texts(),
                "{name} page {}",
                raw.page
            );
            assert_eq!(idx.char_count() as usize, raw.chars.len(), "{name}");
            assert_eq!(idx.has_text(), raw.has_text(), "{name}");
            assert_eq!(idx.page(), raw.page);
            for (i, c) in raw.chars.iter().enumerate() {
                assert_eq!(idx.ch(i as u32), c.ch, "{name} p{} char {i}", raw.page);
            }
            total_lines += raw.lines.len();
        }
    }
    assert!(total_lines > 500, "exercised real lines ({total_lines})");
}

/// A scanned page has no text; the textless flag drives `SearchBatch.textless`.
fn scanned_pdf_is_textless(store: &SessionStore) {
    let doc = open(store, &fixture("scanned.pdf"));
    let pages = extract_all(store, &doc);
    assert!(!pages.is_empty());
    for raw in pages {
        let idx = PageIndex::from_raw(&raw);
        assert!(!idx.has_text());
        assert!(idx.norm().is_empty());
        assert!(idx.line_texts().is_empty());
    }
}

/// Every char box survives quantization within 0.05 pt and is never smaller than the original.
fn box_quantization_is_tight_on_real_pages(store: &SessionStore) {
    let doc = open(store, &fixture("book.pdf"));
    let mut boxed = 0;
    let mut worst = 0.0f32;
    for raw in extract_all(store, &doc) {
        let idx = PageIndex::from_raw(&raw);
        for (i, c) in raw.chars.iter().enumerate() {
            match (c.bbox, idx.box_of(i as u32)) {
                (None, None) => {}
                (Some(a), Some(b)) => {
                    boxed += 1;
                    for d in [
                        (a.x - b.x).abs(),
                        (a.y - b.y).abs(),
                        (a.right() - b.right()).abs(),
                        (a.top() - b.top()).abs(),
                    ] {
                        worst = worst.max(d);
                    }
                    assert!(b.x <= a.x + 1e-3 && b.right() >= a.right() - 1e-3);
                    assert!(b.y <= a.y + 1e-3 && b.top() >= a.top() - 1e-3);
                }
                other => panic!("p{} char {i}: box presence differs {other:?}", raw.page),
            }
        }
    }
    println!("boxes checked: {boxed}, worst quantization error: {worst:.4} pt");
    assert!(boxed > 20_000);
    assert!(worst < 0.05, "quantization error {worst}");
}

/// The tricky zones of `book.pdf` as the index sees them.
fn book_zones_in_the_normalized_stream(store: &SessionStore) {
    let doc = open(store, &fixture("book.pdf"));
    let pages = extract_all(store, &doc);
    let exp = expected();
    let idx = |p: usize| PageIndex::from_raw(&pages[p]);

    // Hard hyphen, page 25 (0-based 24): contra-⏎to and pré-⏎aviso, both U+0002 in PDFium.
    let p = exp["hyphenated"]["contrato"]["page"].as_u64().unwrap() as usize;
    let i = idx(p);
    let text = norm_string(&i);
    assert!(text.contains("contra~to"), "{text}");
    assert!(text.contains("pre~aviso"), "{text}");
    let marker = i.norm().iter().position(|&u| u == HY).expect("marker");
    let o = i.map()[marker];
    assert!(
        i.is_hy(o) && i.ch(o) == '\u{2}',
        "marker maps to the U+0002 char"
    );
    assert!(i.box_of(o).is_some(), "the hyphen glyph is boxed");

    // Soft hyphen, page 26 (0-based 25): U+0002 as well.
    let p = exp["softHyphen"]["page"].as_u64().unwrap() as usize;
    assert!(norm_string(&idx(p)).contains("obriga~coes"));

    // Ligatures, page 27 (0-based 26): expanded by PDFium, two chars sharing one box.
    let p = exp["ligatures"]["page"].as_u64().unwrap() as usize;
    let i = idx(p);
    let text = norm_string(&i);
    assert!(
        text.contains("eficacia do mecanismo e o fluxo das"),
        "{text}"
    );

    // Curly quotes and NBSP, page 18 (0-based 17).
    let p = exp["quotesNbsp"]["page"].as_u64().unwrap() as usize;
    let text = norm_string(&idx(p));
    assert!(text.contains("\"justa causa\""), "{text}");
    assert!(text.contains("art. 12.º"), "{text}");

    // Whitespace: no CR/LF or double space survives in any page's stream.
    for (p, raw) in pages.iter().enumerate() {
        let text = norm_string(&PageIndex::from_raw(raw));
        assert!(
            !text.contains("  ") && !text.contains('\r') && !text.contains('\n'),
            "p{p}"
        );
        assert!(!text.starts_with(' ') && !text.ends_with(' '), "p{p}");
    }
}

/// A synthetic dense page: `n` chars of Portuguese-ish text on 80-char lines, a box each.
fn dense_page(page: u32, n: usize) -> RawPage {
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
    let mut chars = Vec::with_capacity(n + n / 40);
    let mut x = 36.0f32;
    let mut y = 740.0f32;
    let mut w = (page as usize * 7) % WORDS.len();
    while chars.len() < n {
        for c in WORDS[w].chars().chain([' ']) {
            if chars.len() >= n {
                break;
            }
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
    RawPage {
        page,
        width: 612.0,
        height: 792.0,
        chars,
        lines,
    }
}

/// Memory budget (SEARCH-ORCHESTRATION §2.2): ≤ ~40 MB for 500 dense pages (4000 chars each).
fn memory_budget_for_500_dense_pages() {
    const PAGES: usize = 500;
    const CHARS: usize = 4000;
    let start = Instant::now();
    let mut sum = 0usize;
    let mut chars = 0usize;
    for p in 0..PAGES {
        let raw = dense_page(p as u32, CHARS);
        let idx = PageIndex::from_raw(&raw);
        sum += idx.heap_bytes();
        chars += idx.char_count() as usize;
    }
    let mb = sum as f64 / (1024.0 * 1024.0);
    println!(
        "synthetic: {PAGES} pages x {CHARS} chars: {sum} bytes ({mb:.1} MiB), {:.1} B/char, \
         {:.0} bytes/page; built in {:.2?}",
        sum as f64 / chars as f64,
        sum as f64 / PAGES as f64,
        start.elapsed()
    );
    assert!(chars >= PAGES * CHARS);
    assert!(sum <= 40 * 1000 * 1000, "{sum} bytes for 500 dense pages");
    assert!(sum as f64 / chars as f64 <= 17.0);
}

/// The same budget with real pages: book.pdf's pages repeated to 500 pages.
fn memory_budget_with_real_pages(store: &SessionStore) {
    let doc = open(store, &fixture("book.pdf"));
    let pages = extract_all(store, &doc);
    let indexes: Vec<PageIndex> = pages.iter().map(PageIndex::from_raw).collect();
    let real: usize = indexes.iter().map(PageIndex::heap_bytes).sum();
    let chars: usize = pages.iter().map(|p| p.chars.len()).sum();
    let per_page = real as f64 / pages.len() as f64;
    let per_char = real as f64 / chars as f64;
    println!(
        "book.pdf: {} pages, {chars} chars, {real} bytes, {per_page:.0} bytes/page, \
         {per_char:.1} B/char; x500 pages = {:.1} MB",
        pages.len(),
        per_page * 500.0 / 1e6
    );
    assert!(per_page * 500.0 <= 40.0e6);
    assert!(per_char <= 17.0);
}

#[test]
fn search_v2_page_index() {
    init_journal_dir();
    let store = SessionStore::default();

    let mut failures: Vec<&str> = Vec::new();
    macro_rules! case {
        ($name:ident($($arg:expr),*)) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $name($($arg),*))).is_err()
            {
                failures.push(stringify!($name));
            }
        };
    }

    case!(line_texts_and_counts_match_the_raw_pages(&store));
    case!(scanned_pdf_is_textless(&store));
    case!(box_quantization_is_tight_on_real_pages(&store));
    case!(book_zones_in_the_normalized_stream(&store));
    case!(memory_budget_for_500_dense_pages());
    case!(memory_budget_with_real_pages(&store));

    assert!(failures.is_empty(), "failing sub-tests: {failures:#?}");
}
