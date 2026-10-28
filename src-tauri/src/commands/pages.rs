//! `pages` domain — CONTRACTS.md §3. Structural page edits (reorder,
//! rotate, delete, insert) backed by `engine::pages`; validation of the raw
//! request (page ranges, permutation, blank-page dimensions) lives there
//! too, so it's testable without a Tauri `State`/`AppHandle` — see that
//! module's `validate_*` helpers and its own fixture tests.
use tauri::State;
use tauri_specta::Event;

use crate::engine::document::SessionStore;
use crate::engine::history::Command;
// Not `use`-imported as a bare `pages` identifier: every handler below has
// its own `pages: Vec<u32>` parameter (CONTRACTS' frozen IPC surface — see
// `agents/CONTRACTS.md` §6, not something this wave may rename), which
// would shadow a module-level import of that name. Calls into
// `engine::pages`'s free functions therefore always use the full path.
use crate::engine::pages::{
    InsertBlankPageAtCommand, PagesDeleteCommand, PagesInsertFromFileCommand, PagesReorderCommand,
    RotatePagesCommand,
};
use crate::engine::tiles::TileCache;
use crate::types::{
    BlankPageSpec, CmdResult, DocId, DocStateChanged, MutationResult, PageRange, RubricaError,
};

/// Invalidates `result`'s pages in the tile cache and emits
/// `doc_state_changed` — the tail end every handler below shares, mirroring
/// `commands/history.rs`'s `history_undo`/`history_redo`.
fn notify(
    doc_id: &DocId,
    result: &MutationResult,
    dirty: bool,
    tile_cache: &State<'_, TileCache>,
    app: &tauri::AppHandle,
) -> CmdResult<()> {
    tile_cache.invalidate_pages(doc_id, &result.invalidated_pages);
    DocStateChanged {
        doc_id: doc_id.clone(),
        revision: result.revision,
        dirty,
        invalidated_pages: result.invalidated_pages.clone(),
    }
    .emit(app)
    .map_err(|e| RubricaError::internal(e.to_string()))
}

#[tauri::command]
#[specta::specta]
pub fn pages_reorder(
    doc_id: DocId,
    order: Vec<u32>,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        crate::engine::pages::validate_permutation(
            crate::engine::pages::page_count(session),
            &order,
        )?;

        let command: Box<dyn Command> = Box::new(PagesReorderCommand::new(order));
        let result = session.commit(command)?;
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    notify(&doc_id, &result, dirty, &tile_cache, &app)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn pages_rotate(
    doc_id: DocId,
    pages: Vec<u32>,
    degrees: i32,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        crate::engine::pages::validate_pages_in_range(
            crate::engine::pages::page_count(session),
            &pages,
        )?;

        let command: Box<dyn Command> = Box::new(RotatePagesCommand::new(pages, degrees));
        let result = session.commit(command)?;
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    notify(&doc_id, &result, dirty, &tile_cache, &app)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn pages_delete(
    doc_id: DocId,
    pages: Vec<u32>,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        crate::engine::pages::validate_delete(crate::engine::pages::page_count(session), &pages)?;

        let command: Box<dyn Command> = Box::new(PagesDeleteCommand::new(pages));
        let result = session.commit(command)?;
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    notify(&doc_id, &result, dirty, &tile_cache, &app)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn pages_insert_blank(
    doc_id: DocId,
    at: u32,
    spec: BlankPageSpec,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    if spec.width <= 0.0 || spec.height <= 0.0 {
        return Err(RubricaError::invalid_arg(
            "blank page width and height must be positive",
        ));
    }

    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let at = at.min(crate::engine::pages::page_count(session));
        let command: Box<dyn Command> = Box::new(InsertBlankPageAtCommand::new(
            at,
            spec.width as f32,
            spec.height as f32,
        ));
        let result = session.commit(command)?;
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    notify(&doc_id, &result, dirty, &tile_cache, &app)?;
    Ok(result)
}

#[tauri::command]
#[specta::specta]
pub fn pages_insert_from_file(
    doc_id: DocId,
    at: u32,
    path: String,
    range: Option<PageRange>,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let at = at.min(crate::engine::pages::page_count(session));
        let command: Box<dyn Command> = Box::new(PagesInsertFromFileCommand::new(at, path, range));
        let result = session.commit(command)?;
        Ok::<_, RubricaError>((result, session.dirty()))
    })??;

    notify(&doc_id, &result, dirty, &tile_cache, &app)?;
    Ok(result)
}
