//! `forms` domain — CONTRACTS.md §3. Wave-0 stub: every command returns
//! `UNSUPPORTED`. R5 replaces these bodies (`engine::forms`) using PDFium's
//! form API; form values are saved with the AcroForm intact (form *creation*
//! is permanently out of scope — see docs/ARCHITECTURE.md).
use tauri::State;
use tauri_specta::Event;

use crate::engine::document::SessionStore;
use crate::engine::forms;
use crate::engine::tiles::TileCache;
use crate::types::{
    CmdResult, DocId, DocStateChanged, FieldId, FormField, MutationResult, RubricaError,
};

#[tauri::command]
#[specta::specta]
pub fn form_fields(doc_id: DocId, sessions: State<'_, SessionStore>) -> CmdResult<Vec<FormField>> {
    sessions.with_session(&doc_id, move |session| forms::list_fields(session))?
}

#[tauri::command]
#[specta::specta]
pub fn form_set_value(
    doc_id: DocId,
    field_id: FieldId,
    value: String,
    sessions: State<'_, SessionStore>,
    tile_cache: State<'_, TileCache>,
    app: tauri::AppHandle,
) -> CmdResult<MutationResult> {
    let (result, dirty) = sessions.with_session(&doc_id, move |session| {
        let command = forms::validate_set_value(session, &field_id, value)?;
        let result = session.commit(Box::new(command))?;
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
