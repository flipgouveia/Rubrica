//! `annotations` domain — CONTRACTS.md §3. Real PDFium-backed implementation
//! (`engine::annotations`); see that module's doc comment for the mapping
//! decisions (and documented compromises) against pdfium-render 0.9.3.
//! Mirrors `commands/history.rs`'s exact shape: lock `SessionStore`, look up
//! the session, do the work, drop the lock, invalidate tiles, emit
//! `doc_state_changed`, return.

use tauri::State;
use tauri_specta::Event;

use crate::engine::annotations::{self, AddAnnotCommand, DeleteAnnotCommand, UpdateAnnotCommand};
use crate::engine::document::SessionStore;
use crate::engine::tiles::TileCache;
use crate::types::{
    Annot, AnnotId, AnnotPatch, AnnotSpec, CmdResult, DocId, DocStateChanged, MutationResult,
    RubricaError,
};

fn no_such_annotation(annot_id: &str) -> RubricaError {
    RubricaError::not_found(format!("no annotation with id \"{annot_id}\""))
}

#[tauri::command]
#[specta::specta]
pub fn annot_list(
    doc_id: DocId,
    page: u32,
    sessions: State<'_, SessionStore>,
) -> CmdResult<Vec<Annot>> {
    sessions.with_session(&doc_id, move |session| {
        annotations::list_annots(session.document(), page)
    })?
}

#[tauri::command]
#[specta::specta]
pub fn annot_add(
    doc_id: DocId,
    spec: AnnotSpec,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let page_count = session.document().pages().len() as u32;
        let page = annotations::spec_page(&spec);
        if page >= page_count {
            return Err(RubricaError::invalid_arg(format!(
                "page {page} out of range"
            )));
        }

        let result = session.commit(Box::new(AddAnnotCommand::new(spec)))?;
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
pub fn annot_update(
    doc_id: DocId,
    annot_id: AnnotId,
    patch: AnnotPatch,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let (page, index) =
            annotations::parse_annot_id(&annot_id).ok_or_else(|| no_such_annotation(&annot_id))?;

        let result = session.commit(Box::new(UpdateAnnotCommand::new(page, index, patch)))?;
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
pub fn annot_delete(
    doc_id: DocId,
    annot_id: AnnotId,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let (page, index) =
            annotations::parse_annot_id(&annot_id).ok_or_else(|| no_such_annotation(&annot_id))?;

        let result = session.commit(Box::new(DeleteAnnotCommand::new(page, index)))?;
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
