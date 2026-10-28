//! S4: `engine::outline::read_outline` against `book.pdf` (ground truth:
//! `fixtures/book.expected.json`), the fixtures without bookmarks, and hand-built PDFs with
//! hostile / odd outlines (no destination, orphan page object, GoTo action, named destinations,
//! remote and URI actions, cycles, absurd depth and width). Scope resolution on top of the real
//! outline is covered at the end.
//!
//! As in `search_engine.rs` everything PDFium runs on the `SessionStore` owner thread
//! (`with_store` / `with_session`) and all sub-tests are called in sequence from one `#[test]`
//! sharing one store (the vendored PDFium is thread-identity sensitive).

use std::path::{Path, PathBuf};
use std::sync::Once;

use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::outline::{self, MAX_DEPTH, MAX_ENTRIES};
use rubrica_lib::engine::search::scope::{deepest_item_for_page, resolve_scope};
use rubrica_lib::types::{DocId, OutlineItem, RubricaErrorCode, SearchScope};
use serde_json::Value;

static INIT: Once = Once::new();

fn init_journal_dir() {
    INIT.call_once(|| {
        let dir =
            std::env::temp_dir().join(format!("rubrica-outline-journal-{}", std::process::id()));
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

// --- harness ---------------------------------------------------------------------------------

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

fn read(store: &SessionStore, doc: &str) -> Vec<OutlineItem> {
    store
        .with_session(doc, |s| outline::read_outline(s.document()))
        .expect("session")
        .expect("read_outline")
}

fn page_count(store: &SessionStore, doc: &str) -> u32 {
    store
        .with_session(doc, |s| {
            u32::try_from(s.document().pages().len()).expect("page count")
        })
        .expect("session")
}

fn read_path(store: &SessionStore, path: &Path) -> (Vec<OutlineItem>, u32) {
    let doc = open(store, path);
    (read(store, &doc), page_count(store, &doc))
}

/// `(id, title, page, page_end, depth)` in pre-order.
type Flat = (String, String, Option<u32>, Option<u32>, u32);

fn flatten(items: &[OutlineItem], out: &mut Vec<Flat>) {
    for i in items {
        out.push((i.id.clone(), i.title.clone(), i.page, i.page_end, i.depth));
        flatten(&i.children, out);
    }
}

fn flat(items: &[OutlineItem]) -> Vec<Flat> {
    let mut out = Vec::new();
    flatten(items, &mut out);
    out
}

// --- synthesized PDFs ------------------------------------------------------------------------

/// `n_pages` empty pages (objects `3..3+n`), `catalog_extra` spliced into the catalog, then
/// `extra` objects numbered from `3 + n_pages` (so with 3 pages the first extra object is 6).
fn build_pdf(n_pages: usize, catalog_extra: &str, extra: &[String]) -> Vec<u8> {
    let mut objects = vec![
        format!("<< /Type /Catalog /Pages 2 0 R {catalog_extra} >>"),
        format!(
            "<< /Type /Pages /Kids [{}] /Count {n_pages} >>",
            (0..n_pages)
                .map(|i| format!("{} 0 R", 3 + i))
                .collect::<Vec<_>>()
                .join(" ")
        ),
    ];
    for _ in 0..n_pages {
        objects.push("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string());
    }
    objects.extend(extra.iter().cloned());
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

fn entry(title: &str, parent: usize, extra: &str) -> String {
    format!("<< /Title ({title}) /Parent {parent} 0 R {extra} >>")
}

fn write(dir: &Path, name: &str, bytes: Vec<u8>) -> PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, bytes).unwrap();
    path
}

/// Three pages (objects 3, 4, 5); outline root is object 6, entries 7..=17, orphan page 18.
fn mixed_destinations_pdf() -> Vec<u8> {
    let catalog = "/Outlines 6 0 R \
                   /Dests << /chap [4 0 R /Fit] >> \
                   /Names << /Dests << /Names [(chapstr) [5 0 R /Fit]] >> >>";
    let next = |n: usize| format!("/Next {n} 0 R");
    let extra = vec![
        "<< /Type /Outlines /First 7 0 R /Last 17 0 R /Count 11 >>".to_string(),
        // 7: explicit destination, page 0
        entry("Ok", 6, &format!("/Dest [3 0 R /Fit] {}", next(8))),
        // 8: no destination, no action
        entry("NoDest", 6, &next(9)),
        // 9: destination to a /Page object that is not in the page tree (obj 18)
        entry("Orphan", 6, &format!("/Dest [18 0 R /Fit] {}", next(10))),
        // 10: GoTo action, page 2
        entry(
            "GoTo",
            6,
            &format!("/A << /S /GoTo /D [5 0 R /XYZ 0 0 0] >> {}", next(11)),
        ),
        // 11: named destination in the catalog /Dests dictionary -> page 1
        entry("NamedDict", 6, &format!("/Dest /chap {}", next(12))),
        // 12: named destination in the /Names /Dests name tree -> page 2
        entry("NamedTree", 6, &format!("/Dest (chapstr) {}", next(13))),
        // 13: remote GoTo whose /D is a numeric page: must NOT be taken as a local page
        entry(
            "Remote",
            6,
            &format!("/A << /S /GoToR /F (other.pdf) /D [1 /Fit] >> {}", next(14)),
        ),
        // 14: URI action
        entry(
            "Uri",
            6,
            &format!("/A << /S /URI /URI (http://example.com) >> {}", next(15)),
        ),
        // 15: numeric page index beyond the page count
        entry("OutOfRange", 6, &format!("/Dest [99 /Fit] {}", next(16))),
        // 16: padded title, page 1
        entry("  Padded  ", 6, &format!("/Dest [4 0 R /Fit] {}", next(17))),
        // 17: empty title, page 0
        entry("", 6, "/Dest [3 0 R /Fit]"),
        // 18: a page object that is not part of the page tree
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>".to_string(),
    ];
    build_pdf(3, catalog, &extra)
}

fn outline_root(first: usize, last: usize) -> String {
    format!("<< /Type /Outlines /First {first} 0 R /Last {last} 0 R /Count 3 >>")
}

/// Three siblings A(7) B(8) C(9); `c_next` is C's `/Next`.
fn sibling_cycle_pdf(c_next: usize) -> Vec<u8> {
    let extra = vec![
        outline_root(7, 9),
        entry("A", 6, "/Dest [3 0 R /Fit] /Next 8 0 R"),
        entry("B", 6, "/Dest [4 0 R /Fit] /Next 9 0 R"),
        entry("C", 6, &format!("/Dest [5 0 R /Fit] /Next {c_next} 0 R")),
    ];
    build_pdf(3, "/Outlines 6 0 R", &extra)
}

/// A(7) has child B(8) whose `/First` points back at its ancestor A.
fn first_cycle_pdf() -> Vec<u8> {
    let extra = vec![
        outline_root(7, 7),
        entry("A", 6, "/Dest [3 0 R /Fit] /First 8 0 R /Last 8 0 R"),
        entry("B", 7, "/Dest [4 0 R /Fit] /First 7 0 R /Last 7 0 R"),
    ];
    build_pdf(3, "/Outlines 6 0 R", &extra)
}

/// A single entry whose `/Next` and `/First` both point at itself.
fn self_loop_pdf() -> Vec<u8> {
    let extra = vec![
        outline_root(7, 7),
        entry(
            "Self",
            6,
            "/Dest [3 0 R /Fit] /First 7 0 R /Last 7 0 R /Next 7 0 R",
        ),
    ];
    build_pdf(3, "/Outlines 6 0 R", &extra)
}

/// A chain of `levels` entries, each the only child of the previous one.
fn deep_chain_pdf(levels: usize) -> Vec<u8> {
    let mut extra = vec![outline_root(7, 7)];
    for i in 0..levels {
        let obj = 7 + i;
        let parent = if i == 0 { 6 } else { obj - 1 };
        let children = if i + 1 < levels {
            format!("/First {n} 0 R /Last {n} 0 R", n = obj + 1)
        } else {
            String::new()
        };
        extra.push(entry(
            &format!("L{i}"),
            parent,
            &format!("/Dest [{} 0 R /Fit] {children}", 3 + i % 3),
        ));
    }
    build_pdf(3, "/Outlines 6 0 R", &extra)
}

/// `count` top-level siblings, all pointing at page 0.
fn wide_pdf(count: usize) -> Vec<u8> {
    let mut extra = vec![outline_root(7, 6 + count)];
    for i in 0..count {
        let obj = 7 + i;
        let next = if i + 1 < count {
            format!("/Next {} 0 R", obj + 1)
        } else {
            String::new()
        };
        extra.push(entry(
            &format!("W{i}"),
            6,
            &format!("/Dest [3 0 R /Fit] {next}"),
        ));
    }
    build_pdf(3, "/Outlines 6 0 R", &extra)
}

// --- tests: fixtures -------------------------------------------------------------------------

fn compare(got: &[OutlineItem], want: &[Value], prefix: &str, depth: u64) {
    assert_eq!(got.len(), want.len(), "entries under {prefix:?}");
    for (i, (g, w)) in got.iter().zip(want).enumerate() {
        let id = if prefix.is_empty() {
            i.to_string()
        } else {
            format!("{prefix}.{i}")
        };
        assert_eq!(g.id, id, "id");
        assert_eq!(g.title, w["title"].as_str().unwrap(), "title of {id}");
        assert_eq!(
            g.page,
            Some(w["page"].as_u64().unwrap() as u32),
            "page of {id}"
        );
        assert_eq!(
            g.page_end,
            Some(w["pageEnd"].as_u64().unwrap() as u32),
            "pageEnd of {id}"
        );
        assert_eq!(
            u64::from(g.depth),
            w["depth"].as_u64().unwrap(),
            "depth of {id}"
        );
        assert_eq!(u64::from(g.depth), depth);
        compare(
            &g.children,
            w["children"].as_array().unwrap(),
            &id,
            depth + 1,
        );
    }
}

fn book_outline_matches_expected_json(store: &SessionStore) {
    let raw = std::fs::read_to_string(fixture("book.expected.json")).unwrap();
    let expected: Value = serde_json::from_str(&raw).unwrap();
    let (items, pages) = read_path(store, &fixture("book.pdf"));
    assert_eq!(u64::from(pages), expected["pageCount"].as_u64().unwrap());
    compare(&items, expected["outline"].as_array().unwrap(), "", 0);
    assert_eq!(flat(&items).len(), 18);
    // spot-check the id scheme named in the brief
    let f = flat(&items);
    assert!(f.iter().any(|e| e.0 == "2.1.0" && e.1.starts_with("3.2.1")));
}

fn fixtures_without_bookmarks_have_empty_outline(store: &SessionStore) {
    for name in ["book-no-outline.pdf", "text.pdf", "500-page.pdf"] {
        let (items, _) = read_path(store, &fixture(name));
        assert!(items.is_empty(), "{name} should have no outline");
    }
}

// --- tests: synthesized ----------------------------------------------------------------------

fn mixed_destinations(store: &SessionStore, dir: &Path) {
    let (items, pages) = read_path(store, &write(dir, "mixed.pdf", mixed_destinations_pdf()));
    assert_eq!(pages, 3);
    let got: Vec<(String, Option<u32>, Option<u32>)> = items
        .iter()
        .map(|i| (i.title.clone(), i.page, i.page_end))
        .collect();
    println!("mixed destinations -> {got:#?}");
    let want = [
        ("Ok", Some(0), Some(1)),
        ("NoDest", None, None),
        ("Orphan", None, None),
        ("GoTo", Some(2), Some(2)),
        ("NamedDict", Some(1), Some(1)),
        ("NamedTree", Some(2), Some(2)),
        ("Remote", None, None),
        ("Uri", None, None),
        ("OutOfRange", None, None),
        ("Padded", Some(1), Some(1)),
        ("", Some(0), Some(2)),
    ];
    assert_eq!(got.len(), want.len());
    for (g, w) in got.iter().zip(want) {
        assert_eq!((g.0.as_str(), g.1, g.2), w, "entry {:?}", w.0);
    }
    let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
    assert_eq!(
        ids,
        ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]
    );
    assert!(items.iter().all(|i| i.depth == 0 && i.children.is_empty()));
}

fn sibling_cycles_terminate(store: &SessionStore, dir: &Path) {
    // C -> A (the first sibling) and C -> B (an earlier, non-first sibling).
    for (name, c_next) in [
        ("cycle-first.pdf", 7),
        ("cycle-middle.pdf", 8),
        ("cycle-self.pdf", 9),
    ] {
        let (items, _) = read_path(store, &write(dir, name, sibling_cycle_pdf(c_next)));
        let titles: Vec<&str> = items.iter().map(|i| i.title.as_str()).collect();
        assert_eq!(titles, ["A", "B", "C"], "{name}");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["0", "1", "2"], "{name}");
    }
}

fn first_cycle_to_ancestor_terminates(store: &SessionStore, dir: &Path) {
    let (items, _) = read_path(store, &write(dir, "cycle-ancestor.pdf", first_cycle_pdf()));
    let f = flat(&items);
    println!("first-cycle -> {f:#?}");
    assert_eq!(f.len(), 2);
    assert_eq!((f[0].0.as_str(), f[0].1.as_str(), f[0].4), ("0", "A", 0));
    assert_eq!((f[1].0.as_str(), f[1].1.as_str(), f[1].4), ("0.0", "B", 1));
    assert!(items[0].children[0].children.is_empty());
}

fn self_loop_terminates(store: &SessionStore, dir: &Path) {
    let (items, _) = read_path(store, &write(dir, "self-loop.pdf", self_loop_pdf()));
    let f = flat(&items);
    assert_eq!(f.len(), 1);
    assert_eq!(f[0].1, "Self");
}

fn deep_chain_is_cut_at_max_depth(store: &SessionStore, dir: &Path) {
    let (items, _) = read_path(store, &write(dir, "deep.pdf", deep_chain_pdf(100)));
    let f = flat(&items);
    assert_eq!(f.len(), MAX_DEPTH as usize);
    assert_eq!(f.last().unwrap().4, MAX_DEPTH - 1);
    assert_eq!(f.last().unwrap().1, format!("L{}", MAX_DEPTH - 1));
    // ids are the child-index path: "0", "0.0", "0.0.0", ...
    assert_eq!(f[3].0, "0.0.0.0");
    // a chain just inside the cap is kept whole
    let (items, _) = read_path(
        store,
        &write(dir, "deep-ok.pdf", deep_chain_pdf(MAX_DEPTH as usize)),
    );
    assert_eq!(flat(&items).len(), MAX_DEPTH as usize);
}

fn wide_outline_is_capped(store: &SessionStore, dir: &Path) {
    let (items, _) = read_path(store, &write(dir, "wide.pdf", wide_pdf(MAX_ENTRIES + 50)));
    assert_eq!(items.len(), MAX_ENTRIES);
    assert_eq!(items[MAX_ENTRIES - 1].id, (MAX_ENTRIES - 1).to_string());
    let (items, _) = read_path(store, &write(dir, "wide-ok.pdf", wide_pdf(200)));
    assert_eq!(items.len(), 200);
}

// --- tests: scope on the real outline --------------------------------------------------------

fn scope_on_book(store: &SessionStore) {
    let (items, pages) = read_path(store, &fixture("book.pdf"));
    let all = resolve_scope(&SearchScope::All, pages, &items).unwrap();
    assert_eq!(all, 0..=39);
    let range = |id: &str| {
        resolve_scope(&SearchScope::Outline { item_id: id.into() }, pages, &items).unwrap()
    };
    assert_eq!(range("0"), 1..=7);
    assert_eq!(range("2.1.0"), 18..=19); // 3.2.1 Incumprimento definitivo
    assert_eq!(range("2.1"), 16..=19);
    let err = resolve_scope(
        &SearchScope::Outline {
            item_id: "9.9".into(),
        },
        pages,
        &items,
    )
    .unwrap_err();
    assert_eq!(err.code, RubricaErrorCode::InvalidArg);
    let err = resolve_scope(&SearchScope::Pages { from: 5, to: 40 }, pages, &items).unwrap_err();
    assert_eq!(err.code, RubricaErrorCode::InvalidArg);

    // deepest entry for a page in a sub-sub-entry, a sub-entry, between entries, before the first
    let d = |p| deepest_item_for_page(&items, p);
    assert_eq!(d(18).as_deref(), Some("2.1.0"));
    assert_eq!(d(19).as_deref(), Some("2.1.0"));
    assert_eq!(d(17).as_deref(), Some("2.1"));
    assert_eq!(d(0), None);
    assert_eq!(d(1).as_deref(), Some("0.0"));
    assert!(d(39).is_some());

    // no outline: chapter scopes are errors, the rest works
    let (none, pages) = read_path(store, &fixture("book-no-outline.pdf"));
    assert_eq!(deepest_item_for_page(&none, 3), None);
    let err = resolve_scope(
        &SearchScope::Outline {
            item_id: "0".into(),
        },
        pages,
        &none,
    )
    .unwrap_err();
    assert_eq!(err.code, RubricaErrorCode::InvalidArg);
    assert_eq!(
        resolve_scope(&SearchScope::Pages { from: 2, to: 4 }, pages, &none).unwrap(),
        2..=4
    );
}

fn scope_on_entries_without_pages(store: &SessionStore, dir: &Path) {
    let (items, pages) = read_path(store, &write(dir, "mixed2.pdf", mixed_destinations_pdf()));
    // "NoDest" (id 1) has no page: unusable as a scope.
    let err = resolve_scope(
        &SearchScope::Outline {
            item_id: "1".into(),
        },
        pages,
        &items,
    )
    .unwrap_err();
    assert_eq!(err.code, RubricaErrorCode::InvalidArg);
    // pages-less entries are skipped by deepest_item_for_page
    assert_eq!(deepest_item_for_page(&items, 0).as_deref(), Some("0"));
    assert_eq!(deepest_item_for_page(&items, 1).as_deref(), Some("0"));
}

#[test]
fn outline_engine() {
    init_journal_dir();
    let store = SessionStore::default();
    let scratch = tempfile::tempdir().expect("tempdir");
    let dir = scratch.path();

    let mut failures: Vec<&str> = Vec::new();
    macro_rules! case {
        ($name:ident($($arg:expr),*)) => {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| $name($($arg),*))).is_err()
            {
                failures.push(stringify!($name));
            }
        };
    }

    case!(book_outline_matches_expected_json(&store));
    case!(fixtures_without_bookmarks_have_empty_outline(&store));
    case!(mixed_destinations(&store, dir));
    case!(sibling_cycles_terminate(&store, dir));
    case!(first_cycle_to_ancestor_terminates(&store, dir));
    case!(self_loop_terminates(&store, dir));
    case!(deep_chain_is_cut_at_max_depth(&store, dir));
    case!(wide_outline_is_capped(&store, dir));
    case!(scope_on_book(&store));
    case!(scope_on_entries_without_pages(&store, dir));

    assert!(failures.is_empty(), "failing sub-tests: {failures:#?}");
}
