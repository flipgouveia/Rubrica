//! Search performance numbers for `agents/SEARCH-ORCHESTRATION.md` §2.2 (budget: first search
//! ≤ 1.5× the phase-1 engine, cached searches ≥ 3× faster, index ≤ ~40 MB for 500 dense pages).
//! Not a pass/fail gate in CI: run on demand and read the printed numbers. The phase-1 engine is
//! gone; its recorded release baseline was book.pdf "contrato" 69 ms, 500-page.pdf "page" 31 ms,
//! text.pdf "the" 4 ms (first search).
//!
//! cargo test --manifest-path src-tauri/Cargo.toml --release --test search_perf -- --ignored --nocapture

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use rubrica_lib::engine::document::{DocumentSession, SessionStore};
use rubrica_lib::engine::search::pipeline;
use rubrica_lib::engine::text;
use rubrica_lib::types::{DocId, ProximityOptions, SearchMode, SearchQuery, SearchScope};

fn fixture(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "..", "fixtures", name]
        .iter()
        .collect()
}

fn open(store: &SessionStore, name: &str) -> DocId {
    std::env::set_var(
        "RUBRICA_JOURNAL_DIR",
        std::env::temp_dir().join(format!("rubrica-perf-journal-{}", std::process::id())),
    );
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

fn v2_query(text: &str) -> SearchQuery {
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

/// The search v2 pipeline (`engine::search::pipeline`), exactly as `text_search_start` runs it.
fn v2(store: &SessionStore, doc: &str, query: &SearchQuery) -> (Duration, usize) {
    let started = Instant::now();
    let plan = pipeline::prepare(store, doc, query).unwrap();
    let mut hits = 0;
    pipeline::run(store, doc, "perf", plan, &AtomicBool::new(false), |batch| {
        hits += batch.matches.iter().map(|m| m.hits.len()).sum::<usize>()
    });
    (started.elapsed(), hits)
}

#[test]
#[ignore = "perf numbers, run on demand"]
fn v2_pipeline() {
    let store = SessionStore::default();
    for (name, query) in [
        ("book.pdf", "contrato"),
        ("500-page.pdf", "page"),
        ("text.pdf", "the"),
    ] {
        let doc = open(&store, name);
        let (first, hits) = v2(&store, &doc, &v2_query(query));
        let (second, _) = v2(&store, &doc, &v2_query(query));
        let mut proximity = v2_query("rescisão prazo indemnização");
        proximity.mode = SearchMode::Proximity;
        proximity.proximity = Some(ProximityOptions { window: 500 });
        proximity.exclude_headers_footers = true;
        let (prox, zones) = v2(&store, &doc, &proximity);
        let bytes = store
            .with_session(&doc, |s| s.search_cache().heap_bytes())
            .unwrap();
        let pages = store.with_session(&doc, |s| text::page_count(s)).unwrap();
        println!(
            "v2     {name:14} {query:9} hits={hits:5} first={:7.1}ms cached={:7.1}ms \
             proximity+furniture={:7.1}ms zones={zones} index={:.1}KB ({:.1}KB/page)",
            first.as_secs_f64() * 1000.0,
            second.as_secs_f64() * 1000.0,
            prox.as_secs_f64() * 1000.0,
            bytes as f64 / 1024.0,
            bytes as f64 / 1024.0 / pages.max(1) as f64,
        );
    }
}
