//! `document` domain — CONTRACTS.md §3. Real `DocumentSession`-backed
//! implementation; see `src-tauri/API.md`.

use std::sync::Mutex;

use tauri::State;
use tauri_specta::Event;

use crate::engine::document::{DocumentSession, SessionStore};
use crate::store::Store;
use crate::types::{
    CmdResult, DocId, DocInfo, DocStateChanged, RubricaError, SaveState, SaveStateChanged,
};

fn not_found(doc_id: &str) -> RubricaError {
    RubricaError::not_found(format!("no open document with id \"{doc_id}\""))
}

fn backup_pref(store: &State<'_, Mutex<Store>>) -> bool {
    store
        .lock()
        .ok()
        .and_then(|s| s.prefs_get("save.backup").ok().flatten())
        .map(|v| v != "false")
        .unwrap_or(true)
}

#[tauri::command]
#[specta::specta]
pub fn doc_open(
    path: String,
    sessions: State<'_, SessionStore>,
    store: State<'_, Mutex<Store>>,
) -> CmdResult<DocInfo> {
    // `DocumentSession::open` creates a `PdfDocument`, so — like every PDFium
    // touch in the app — it must run on the `SessionStore` owner thread, not
    // just the registry insert afterwards. PDFium is not safe to call from
    // more than one thread even across *different* documents (see `API.md` /
    // `SessionStore`'s doc comment); the owner thread is what makes that safe.
    let open_path = path.clone();
    let info = sessions.with_store(move |sessions| {
        let session = DocumentSession::open(&open_path)?;
        let info = session.info();
        sessions.insert(info.doc_id.clone(), session);
        Ok::<_, RubricaError>(info)
    })??;

    // Best-effort — matching `mock/app.ts::recordRecent`, always resets to
    // defaults on open rather than trying to preserve a prior view state
    // that no CONTRACTS command ever actually writes. See API.md.
    if let Ok(store) = store.lock() {
        let _ = store.recents_upsert(&path, 0, 1.0);
    }

    Ok(info)
}

#[tauri::command]
#[specta::specta]
pub fn doc_close(doc_id: DocId, sessions: State<'_, SessionStore>) -> CmdResult<()> {
    let closed_id = doc_id.clone();
    sessions.with_store(move |sessions| {
        let mut session = sessions.remove(&doc_id).ok_or_else(|| not_found(&doc_id))?;
        // A deliberate close, dirty or not, discards unsaved edits — dropping
        // `session` at the end of this closure already does that (the next
        // `doc_open` reloads fresh bytes from disk), and — crucially — that
        // drop runs `FPDF_CloseDocument` here on the owner thread, never a
        // foreign one. Only the journal needs an explicit delete, since a
        // future open shouldn't offer to "recover" a crash that never
        // happened.
        session.forget_journal();
        Ok::<_, RubricaError>(())
    })??;
    // The rendered print pages are a copy of this document's pages in the temp dir; they go with it.
    crate::commands::app::clear_print_renders(&closed_id);
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn doc_save(
    doc_id: DocId,
    sessions: State<'_, SessionStore>,
    store: State<'_, Mutex<Store>>,
    app: tauri::AppHandle,
) -> CmdResult<()> {
    let make_backup = backup_pref(&store);

    // Confirm the session exists *before* emitting `save_state: saving` —
    // otherwise a `doc_save` for an unknown/already-closed doc would announce
    // a save that's about to fail with no matching "saved" follow-up. (This
    // cheap existence check plus the save itself are two owner-thread hops
    // rather than one held lock; a close racing in between just makes the
    // save error, same net outcome as before.)
    sessions.with_session(&doc_id, |_| ())?;

    SaveStateChanged {
        doc_id: doc_id.clone(),
        state: SaveState::Saving,
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    let (revision, dirty) = sessions.with_session(&doc_id, move |session| {
        session.save(make_backup)?;
        Ok::<_, RubricaError>((session.revision(), session.dirty()))
    })??;

    SaveStateChanged {
        doc_id: doc_id.clone(),
        state: SaveState::Saved,
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;
    DocStateChanged {
        doc_id,
        revision,
        dirty,
        invalidated_pages: Vec::new(),
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn doc_save_as(
    doc_id: DocId,
    path: String,
    sessions: State<'_, SessionStore>,
    store: State<'_, Mutex<Store>>,
    app: tauri::AppHandle,
) -> CmdResult<()> {
    let make_backup = backup_pref(&store);

    // See `doc_save` above for why existence is confirmed before the
    // `saving` event, not after.
    sessions.with_session(&doc_id, |_| ())?;

    SaveStateChanged {
        doc_id: doc_id.clone(),
        state: SaveState::Saving,
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    let save_path = path.clone();
    let (revision, dirty) = sessions.with_session(&doc_id, move |session| {
        session.save_as(&save_path, make_backup)?;
        Ok::<_, RubricaError>((session.revision(), session.dirty()))
    })??;

    if let Ok(store) = store.lock() {
        let _ = store.recents_upsert(&path, 0, 1.0);
    }

    SaveStateChanged {
        doc_id: doc_id.clone(),
        state: SaveState::Saved,
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;
    DocStateChanged {
        doc_id,
        revision,
        dirty,
        invalidated_pages: Vec::new(),
    }
    .emit(&app)
    .map_err(|e| RubricaError::internal(e.to_string()))?;

    Ok(())
}

#[tauri::command]
#[specta::specta]
pub fn doc_list_open(sessions: State<'_, SessionStore>) -> CmdResult<Vec<DocInfo>> {
    sessions.with_store(|sessions| sessions.values().map(DocumentSession::info).collect())
}
