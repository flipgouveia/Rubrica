//! `text` domain — CONTRACTS.md §3. Real PDFium-backed text layer and
//! streamed search; see `src-tauri/API.md`'s "Text layer & search" section.
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Manager, State};
use tauri_specta::Event;

use crate::engine::document::SessionStore;
use crate::engine::search::pipeline;
use crate::engine::text::{self, SearchRegistry};
use crate::types::{CharBox, CmdResult, DocId, SearchId, SearchQuery, TextRange};

#[tauri::command]
#[specta::specta]
pub fn text_page_layout(
    doc_id: DocId,
    page: u32,
    sessions: State<'_, SessionStore>,
) -> CmdResult<Vec<CharBox>> {
    sessions.with_session(&doc_id, move |session| text::page_layout(session, page))?
}

#[tauri::command]
#[specta::specta]
pub fn text_extract_range(
    doc_id: DocId,
    range: TextRange,
    sessions: State<'_, SessionStore>,
) -> CmdResult<String> {
    sessions.with_session(&doc_id, move |session| {
        text::extract_range(session, range.page, range.start, range.end)
    })?
}

#[tauri::command]
#[specta::specta]
pub fn text_search_start(
    doc_id: DocId,
    search_id: SearchId,
    query: SearchQuery,
    sessions: State<'_, SessionStore>,
    app: AppHandle,
) -> CmdResult<()> {
    // Validated synchronously, so NOT_FOUND / INVALID_ARG reach the caller.
    let plan = pipeline::prepare(&sessions, &doc_id, &query)?;

    // `INVALID_ARG` when the client-minted id is already running.
    let cancelled = text::register_search(&app.state::<SearchRegistry>(), &search_id)?;

    tauri::async_runtime::spawn_blocking(move || {
        run_search(app, doc_id, plan, search_id, cancelled);
    });

    Ok(())
}

/// Streams `search_batch` events. The page loop, batching, caching and cancellation rules live
/// in [`pipeline::run`] (shared with the integration tests); every PDFium touch hops to the owner
/// thread one page at a time, so rendering and mutations still interleave.
fn run_search(
    app: AppHandle,
    doc_id: DocId,
    plan: pipeline::SearchPlan,
    search_id: SearchId,
    cancelled: Arc<AtomicBool>,
) {
    let sessions = app.state::<SessionStore>();
    pipeline::run(&sessions, &doc_id, &search_id, plan, &cancelled, |batch| {
        let _ = batch.emit(&app);
    });
    app.state::<SearchRegistry>().finish(&search_id);
}

#[tauri::command]
#[specta::specta]
pub fn text_search_cancel(
    search_id: SearchId,
    search_registry: State<'_, SearchRegistry>,
) -> CmdResult<()> {
    search_registry.cancel(&search_id);
    Ok(())
}
