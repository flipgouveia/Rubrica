//! The search v2 pipeline behind `text_search_start` (`agents/SEARCH-ORCHESTRATION.md` §2.2),
//! free of Tauri so integration tests can drive it with a bare [`SessionStore`]:
//!
//! 1. [`prepare`] (synchronous, so `INVALID_ARG` reaches the caller): compile the query, read the
//!    outline, resolve the scope to a page range.
//! 2. [`run`] (on the search task): with `excludeHeadersFooters`, make sure every page is indexed
//!    and headers/footers are detected (cached per document); then feed the scope's pages, in
//!    order, to the matcher and stream `search_batch`es.
//!
//! PDFium is only touched inside `with_session` hops — one page per hop, so rendering and
//! mutations still interleave — and only through [`extract`]. Matching runs here, off the
//! PDFium thread, on `Arc`s taken out of the session's [`super::SearchCache`].
//!
//! Batching: all hits that start on a page travel in ONE batch (a hit may finish on the next
//! page, so page k is only emitted once page k+1 has been matched, or at the end). A batch goes
//! out for every finished page with hits and at least every [`PROGRESS_EVERY_PAGES`] pages.

use std::collections::BTreeMap;
use std::ops::RangeInclusive;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pdfium_render::prelude::PdfPageIndex;

use super::extract;
use super::furniture::{self, Furniture};
use super::index::PageIndex;
use super::matcher::{self, CompiledQuery, FoundHit, Matcher};
use super::scope;
use super::PageLines;
use crate::engine::document::SessionStore;
use crate::engine::outline;
use crate::types::{
    CmdResult, OutlineItem, PageFurniture, SearchBatch, SearchHit, SearchMatch, SearchMode,
    SearchQuery,
};

/// Emit a progress batch at least this often (CONTRACTS v1.2.0 §4).
pub const PROGRESS_EVERY_PAGES: u32 = 25;

/// Everything [`run`] needs, validated up front.
pub struct SearchPlan {
    pub query: Arc<CompiledQuery>,
    pub mode: SearchMode,
    pub pages: RangeInclusive<u32>,
    pub outline: Arc<Vec<OutlineItem>>,
    pub exclude_headers_footers: bool,
}

/// Validates `query` against the open document. `NOT_FOUND` for an unknown document,
/// `INVALID_ARG` for a bad query or scope.
pub fn prepare(store: &SessionStore, doc_id: &str, query: &SearchQuery) -> CmdResult<SearchPlan> {
    let compiled = matcher::compile(query)?;
    let (page_count, outline) = store.with_session(doc_id, |session| {
        let page_count = session.document().pages().len().max(0) as u32;
        // A document whose bookmarks can't be read searches as if it had none.
        let outline = outline::read_outline(session.document()).unwrap_or_default();
        (page_count, outline)
    })?;
    let pages = scope::resolve_scope(&query.scope, page_count, &outline)?;
    Ok(SearchPlan {
        query: Arc::new(compiled),
        mode: query.mode,
        pages,
        outline: Arc::new(outline),
        exclude_headers_footers: query.exclude_headers_footers,
    })
}

/// Builds (and caches) the index of `page` in one PDFium hop; returns the cached one if another
/// search built it meanwhile. `None` when the document is gone or the page doesn't exist.
fn build_page_index(store: &SessionStore, doc_id: &str, page: u32) -> Option<Arc<PageIndex>> {
    store
        .with_session(doc_id, move |session| {
            if let Some(index) = session.search_cache().page(page) {
                return Some(index);
            }
            let built = {
                let pdf_page = session.document().pages().get(page as PdfPageIndex).ok()?;
                Arc::new(PageIndex::from_raw(&extract::extract_page(&pdf_page, page)))
            };
            session.search_cache_mut().insert_page(page, built.clone());
            Some(built)
        })
        .ok()
        .flatten()
}

/// Every already-cached index of `pages`, in ONE hop (a cached search must not pay one PDFium
/// round trip per page). `None` when the document is gone.
fn cached_indexes(
    store: &SessionStore,
    doc_id: &str,
    pages: RangeInclusive<u32>,
) -> Option<Vec<Option<Arc<PageIndex>>>> {
    store
        .with_session(doc_id, move |session| {
            pages
                .map(|page| session.search_cache().page(page))
                .collect()
        })
        .ok()
}

/// The indexes of `pages`, in order: cached ones taken in a single hop, missing ones built one page
/// per hop (so rendering and mutations interleave). `on_page` receives each as soon as it is ready
/// and returns `false` to stop. Returns `false` when the document went away or `on_page` stopped.
fn for_each_index(
    store: &SessionStore,
    doc_id: &str,
    pages: RangeInclusive<u32>,
    mut on_page: impl FnMut(u32, Arc<PageIndex>) -> bool,
) -> bool {
    let Some(cached) = cached_indexes(store, doc_id, pages.clone()) else {
        return false;
    };
    for (page, cached) in pages.zip(cached) {
        let index = match cached {
            Some(index) => index,
            None => match build_page_index(store, doc_id, page) {
                Some(index) => index,
                None => return false,
            },
        };
        if !on_page(page, index) {
            return false;
        }
    }
    true
}

/// Headers/footers for the whole document (detection needs every page), cached on the session.
/// `None` when the document went away or the search was cancelled meanwhile.
fn ensure_furniture(
    store: &SessionStore,
    doc_id: &str,
    cancelled: &AtomicBool,
) -> Option<Arc<Furniture>> {
    let (cached, page_count) = store
        .with_session(doc_id, |session| {
            (
                session.search_cache().furniture(),
                session.document().pages().len().max(0) as u32,
            )
        })
        .ok()?;
    if let Some(furniture) = cached {
        return Some(furniture);
    }
    if page_count == 0 {
        return Some(Arc::new(Furniture::default()));
    }
    let mut pages = Vec::with_capacity(page_count as usize);
    let complete = for_each_index(store, doc_id, 0..=page_count - 1, |page, index| {
        pages.push(PageLines {
            page,
            height: index.height(),
            lines: index.line_texts(),
        });
        !cancelled.load(Ordering::Relaxed)
    });
    if !complete {
        return None;
    }
    let furniture = Arc::new(furniture::detect(&pages));
    let stored = furniture.clone();
    store
        .with_session(doc_id, move |session| {
            session.search_cache_mut().set_furniture(stored)
        })
        .ok()?;
    Some(furniture)
}

/// One page's hits in document order (the matcher may return a spanning hit after later ones).
fn page_match(page: u32, mut hits: Vec<SearchHit>) -> SearchMatch {
    hits.sort_by_key(|hit| hit.char_start);
    SearchMatch { page, hits }
}

fn with_outline(mut found: FoundHit, outline: &[OutlineItem]) -> (u32, SearchHit) {
    found.hit.outline_item_id = scope::deepest_item_for_page(outline, found.page);
    (found.page, found.hit)
}

/// Runs a prepared search and streams its batches through `emit`. Cancellation is checked
/// before and after every page hop; a cancelled search emits nothing further, not even `done`.
/// A document that goes away ends the search silently. Returns `true` iff `done` was emitted.
pub fn run(
    store: &SessionStore,
    doc_id: &str,
    search_id: &str,
    plan: SearchPlan,
    cancelled: &AtomicBool,
    mut emit: impl FnMut(SearchBatch),
) -> bool {
    let furniture = if plan.exclude_headers_footers {
        match ensure_furniture(store, doc_id, cancelled) {
            Some(furniture) => Some(furniture),
            None => return false,
        }
    } else {
        None
    };

    let page_count = plan.pages.end() - plan.pages.start() + 1;
    let mut matcher = Matcher::new(plan.query.clone());
    // Hits by start page, held until that page can no longer receive hits.
    let mut pending: BTreeMap<u32, Vec<SearchHit>> = BTreeMap::new();
    let mut ready: Vec<SearchMatch> = Vec::new();
    let mut ready_furniture: Vec<PageFurniture> = Vec::new();
    let mut any_text = false;
    let mut last_emitted = 0u32;

    let batch = |matches, pages_searched, furniture, done, textless| SearchBatch {
        search_id: search_id.to_owned(),
        matches,
        done,
        pages_searched,
        page_count,
        textless,
        ranked: done && plan.mode == SearchMode::Proximity,
        furniture,
    };

    if cancelled.load(Ordering::Relaxed) {
        return false;
    }
    let mut pages_searched = 0u32;
    let complete = for_each_index(store, doc_id, plan.pages.clone(), |page, index| {
        if cancelled.load(Ordering::Relaxed) {
            return false;
        }
        any_text |= index.has_text();
        let excluded = furniture
            .as_ref()
            .map(|f| f.excluded_ranges(page))
            .unwrap_or_default();
        if let Some(page_furniture) = furniture.as_ref().and_then(|f| f.page_furniture(page)) {
            ready_furniture.push(page_furniture);
        }
        for found in matcher.push_page(index, &excluded) {
            let (start, hit) = with_outline(found, &plan.outline);
            pending.entry(start).or_default().push(hit);
        }
        // Every page before this one is final now: a hit can only continue one page further.
        let still_open = pending.split_off(&page);
        for (start, hits) in std::mem::replace(&mut pending, still_open) {
            ready.push(page_match(start, hits));
        }

        pages_searched += 1;
        if !ready.is_empty() || pages_searched - last_emitted >= PROGRESS_EVERY_PAGES {
            emit(batch(
                std::mem::take(&mut ready),
                pages_searched,
                std::mem::take(&mut ready_furniture),
                false,
                false,
            ));
            last_emitted = pages_searched;
        }
        true
    });

    if !complete || cancelled.load(Ordering::Relaxed) {
        return false;
    }
    for found in matcher.finish() {
        let (start, hit) = with_outline(found, &plan.outline);
        pending.entry(start).or_default().push(hit);
    }
    for (start, hits) in std::mem::take(&mut pending) {
        ready.push(page_match(start, hits));
    }
    emit(batch(ready, page_count, ready_furniture, true, !any_text));
    true
}
