//! `redact` domain — CONTRACTS.md §3. Real `engine::redact`-backed implementation: removes the
//! underlying text/image objects and rasterizes the region. Whiteout is deliberately NOT here:
//! it's an opaque `shape` annotation (see `types::AnnotSpec`); the two tools are separate on
//! purpose (docs/ARCHITECTURE.md).
use tauri::State;
use tauri_specta::Event;

use crate::engine::document::SessionStore;
use crate::engine::redact::RedactCommand;
use crate::engine::tiles::TileCache;
use crate::types::{CmdResult, DocId, DocStateChanged, MutationResult, Rect, RubricaError};

#[tauri::command]
#[specta::specta]
pub fn redact_apply(
    doc_id: DocId,
    page: u32,
    rects: Vec<Rect>,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (mutation, dirty) = sessions.with_session(&doc_id, move |session| {
        let mutation = session.commit(Box::new(RedactCommand::new(page, rects)))?;
        Ok::<_, RubricaError>((mutation, session.dirty()))
    })??;

    tile_cache.invalidate_pages(&doc_id, &mutation.invalidated_pages);
    DocStateChanged {
        doc_id,
        revision: mutation.revision,
        dirty,
        invalidated_pages: mutation.invalidated_pages.clone(),
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    Ok(mutation)
}
