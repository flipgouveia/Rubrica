//! `textedit` domain — CONTRACTS.md §3. Real `engine::textedit`-backed implementation: in-place
//! text-run editing reuses the run's font where possible and sets `fontSubstituted` when it
//! can't; deliberately no paragraph reflow.
use std::sync::atomic::Ordering;

use tauri::State;
use tauri_specta::Event;

use crate::engine::document::SessionStore;
use crate::engine::textedit::{
    self, AddImageObjectCommand, AddTextObjectCommand, DeleteObjectCommand, SetTextCommand,
};
use crate::engine::tiles::TileCache;
use crate::types::{
    CmdResult, DocId, DocStateChanged, ImageObjectSpec, MutationResult, ObjectId, RubricaError,
    SetTextResult, TextObjectSpec, TextRun,
};

#[tauri::command]
#[specta::specta]
pub fn text_objects(
    doc_id: DocId,
    page: u32,
    sessions: State<'_, SessionStore>,
) -> CmdResult<Vec<TextRun>> {
    sessions.with_session(&doc_id, move |session| {
        textedit::list_text_runs(session, page)
    })?
}

#[tauri::command]
#[specta::specta]
pub fn textobj_set_text(
    doc_id: DocId,
    object_id: ObjectId,
    text: String,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<SetTextResult> {
    let (page, index) = textedit::parse_object_id(&object_id)?;

    let (command, substituted_flag) = SetTextCommand::new(page, index, text);
    let (mutation, dirty) = sessions.with_session(&doc_id, move |session| {
        let mutation = session.commit(Box::new(command))?;
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

    Ok(SetTextResult {
        mutation,
        font_substituted: substituted_flag.load(Ordering::Relaxed),
    })
}

#[tauri::command]
#[specta::specta]
pub fn textobj_add(
    doc_id: DocId,
    page: u32,
    spec: TextObjectSpec,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    commit_mutation(
        &doc_id,
        &sessions,
        &tile_cache,
        &app,
        Box::new(AddTextObjectCommand::new(page, spec)),
    )
}

#[tauri::command]
#[specta::specta]
pub fn imageobj_add(
    doc_id: DocId,
    page: u32,
    spec: ImageObjectSpec,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    commit_mutation(
        &doc_id,
        &sessions,
        &tile_cache,
        &app,
        Box::new(AddImageObjectCommand::new(page, spec)),
    )
}

#[tauri::command]
#[specta::specta]
pub fn object_delete(
    doc_id: DocId,
    object_id: ObjectId,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (page, index) = textedit::parse_object_id(&object_id)?;
    commit_mutation(
        &doc_id,
        &sessions,
        &tile_cache,
        &app,
        Box::new(DeleteObjectCommand::new(page, index)),
    )
}

/// Shared tail for the three commands here that only need a plain `MutationResult` back —
/// `textobj_set_text` doesn't use this since it also needs `fontSubstituted` out of the flag
/// `SetTextCommand::new` hands out.
fn commit_mutation(
    doc_id: &DocId,
    sessions: &State<'_, SessionStore>,
    tile_cache: &State<'_, TileCache>,
    app: &tauri::AppHandle,
    command: Box<dyn crate::engine::history::Command>,
) -> CmdResult<MutationResult> {
    let (mutation, dirty) = sessions.with_session(doc_id, move |session| {
        let mutation = session.commit(command)?;
        Ok::<_, RubricaError>((mutation, session.dirty()))
    })??;

    tile_cache.invalidate_pages(doc_id, &mutation.invalidated_pages);
    DocStateChanged {
        doc_id: doc_id.clone(),
        revision: mutation.revision,
        dirty,
        invalidated_pages: mutation.invalidated_pages.clone(),
    }
    .emit(app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    Ok(mutation)
}
