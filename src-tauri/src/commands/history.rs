//! `history` domain — CONTRACTS.md §3. Undo/redo over
//! `engine::document::DocumentSession`'s command stack. A no-op undo/redo
//! (nothing on the relevant stack) returns the current revision with no
//! invalidated pages rather than an error, matching `mock/history.ts`.
use tauri::State;
use tauri_specta::Event;

use crate::engine::document::SessionStore;
use crate::engine::tiles::TileCache;
use crate::types::{CmdResult, DocId, DocStateChanged, HistoryState, MutationResult, RubricaError};

#[tauri::command]
#[specta::specta]
pub fn history_undo(
    doc_id: DocId,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let result = match session.undo()? {
            Some(result) => result,
            None => MutationResult {
                revision: session.revision(),
                invalidated_pages: Vec::new(),
            },
        };
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    tile_cache.invalidate_pages(&doc_id, &result.invalidated_pages);
    DocStateChanged {
        doc_id,
        revision: result.revision,
        dirty,
        invalidated_pages: result.invalidated_pages.clone(),
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn history_redo(
    doc_id: DocId,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let result = match session.redo()? {
            Some(result) => result,
            None => MutationResult {
                revision: session.revision(),
                invalidated_pages: Vec::new(),
            },
        };
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    tile_cache.invalidate_pages(&doc_id, &result.invalidated_pages);
    DocStateChanged {
        doc_id,
        revision: result.revision,
        dirty,
        invalidated_pages: result.invalidated_pages.clone(),
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn history_state(doc_id: DocId, sessions: State<'_, SessionStore>) -> CmdResult<HistoryState> {
    sessions.with_session(&doc_id, move |session| {
        Ok::<_, RubricaError>(HistoryState {
            can_undo: session.can_undo(),
            can_redo: session.can_redo(),
            dirty: session.dirty(),
        })
    })?
}
