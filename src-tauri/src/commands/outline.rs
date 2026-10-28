//! `outline` domain — CONTRACTS v1.2.0 §3 (`doc_outline`).
use tauri::State;

use crate::engine::document::SessionStore;
use crate::engine::outline;
use crate::types::{CmdResult, DocId, OutlineItem};

#[tauri::command]
#[specta::specta]
pub fn doc_outline(
    doc_id: DocId,
    sessions: State<'_, SessionStore>,
) -> CmdResult<Vec<OutlineItem>> {
    sessions.with_session(&doc_id, |session| outline::read_outline(session.document()))?
}
