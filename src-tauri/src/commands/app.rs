//! `app` domain — CONTRACTS.md §3. `prefs_get`/`prefs_set`/`recents_list`/
//! `recents_clear` are wired to the real SQLite store (`crate::store`,
//! CONTRACTS §8) — trivial, and everyone needs them. `print_render` renders
//! via `engine::tiles::render_page_at_dpi`; `journal_recover` reads
//! `engine::journal` — see `src-tauri/API.md` for both.
//!
//! Preference values are opaque JSON-encoded strings at the IPC boundary —
//! the frontend is responsible for `JSON.stringify`/`JSON.parse`; this keeps
//! the command signature stable regardless of what any given pref stores.

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;

use crate::engine::document::SessionStore;
use crate::engine::{journal, tiles};
use crate::store::Store;
use crate::types::{CmdResult, DocId, RecentDoc, RecoveryInfo, RubricaError};

fn io_err(err: impl std::fmt::Display) -> RubricaError {
    RubricaError::io(err.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn recents_list(store: State<'_, Mutex<Store>>) -> CmdResult<Vec<RecentDoc>> {
    let store = store.lock().map_err(io_err)?;
    store
        .recents_list()
        .map(|rows| {
            rows.into_iter()
                .map(|r| RecentDoc {
                    path: r.path,
                    last_opened_at: r.last_opened_at,
                    last_page: r.last_page,
                    last_zoom: r.last_zoom,
                })
                .collect()
        })
        .map_err(io_err)
}

#[tauri::command]
#[specta::specta]
pub fn recents_clear(store: State<'_, Mutex<Store>>) -> CmdResult<()> {
    let store = store.lock().map_err(io_err)?;
    store.recents_clear().map_err(io_err)
}

#[tauri::command]
#[specta::specta]
pub fn prefs_get(store: State<'_, Mutex<Store>>, key: String) -> CmdResult<Option<String>> {
    let store = store.lock().map_err(io_err)?;
    store.prefs_get(&key).map_err(io_err)
}

#[tauri::command]
#[specta::specta]
pub fn prefs_set(store: State<'_, Mutex<Store>>, key: String, value: String) -> CmdResult<()> {
    let store = store.lock().map_err(io_err)?;
    store.prefs_set(&key, &value).map_err(io_err)
}

/// The `<temp>/rubrica-print` root that [`print_render_path`] writes under.
fn print_render_root() -> PathBuf {
    std::env::temp_dir().join("rubrica-print")
}

/// Removes the rendered print pages of one document. Called only for a `docId` that was just
/// removed from the open-session registry, so it can never be a path from the webview.
pub fn clear_print_renders(doc_id: &str) {
    let _ = fs::remove_dir_all(print_render_root().join(doc_id));
}

/// Removes every rendered print page left behind by earlier runs. `DocId`s restart at `doc-1`
/// each launch, so a stale directory could otherwise be mistaken for a current one.
pub fn clear_all_print_renders() {
    let _ = fs::remove_dir_all(print_render_root());
}

/// Where `print_render` writes one page's PNG: `<temp>/rubrica-print/<docId>/page-<n>-<dpi>dpi.png`
/// (`page` is 0-based, the file name 1-based). Shared with the `rubrica-print` protocol handler
/// (`protocols.rs`), which rebuilds the path from the numeric URL fields instead of ever taking
/// a file path from the webview — so the two can't drift apart.
pub fn print_render_path(doc_id: &str, page: u32, dpi: u32) -> PathBuf {
    print_render_root()
        .join(doc_id)
        .join(format!("page-{}-{dpi}dpi.png", page.saturating_add(1)))
}

#[tauri::command]
#[specta::specta]
pub fn print_render(
    doc_id: DocId,
    pages: Vec<u32>,
    dpi: u32,
    sessions: State<'_, SessionStore>,
) -> CmdResult<Vec<String>> {
    // Confirm the document is open before doing any filesystem work — matches
    // the pre-actor behavior (existence checked up front, before the temp dir
    // was created) rather than only discovering it inside the per-page loop
    // (which an empty `pages` list would skip entirely).
    sessions.with_session(&doc_id, |_| ())?;

    let dir = print_render_root().join(&doc_id);
    fs::create_dir_all(&dir).map_err(io_err)?;

    let mut paths = Vec::with_capacity(pages.len());
    for page in pages {
        // Each page is rasterized+encoded on the PDFium owner thread (print is
        // infrequent, so encoding there rather than off-thread is fine); the
        // temp-file write stays out here on the command thread.
        let png = sessions.with_session(&doc_id, move |session| {
            tiles::render_page_at_dpi(session, page, dpi)
        })??;
        let path = print_render_path(&doc_id, page, dpi);
        fs::write(&path, png).map_err(io_err)?;
        paths.push(path.to_string_lossy().into_owned());
    }
    Ok(paths)
}

/// See `src-tauri/API.md`'s "Autosave journal" section for the two readings
/// this command needs to serve: `None` asks "is there a crash to recover
/// from" (the startup case — every journal on disk is orphaned, since
/// nothing has attached to any of them yet); `Some(doc_id)` asks "does this
/// already-open document have live autosave state" (any journal at all,
/// since a normal editing session's own journal is exactly that).
#[tauri::command]
#[specta::specta]
pub fn journal_recover(
    doc_id: Option<DocId>,
    sessions: State<'_, SessionStore>,
) -> CmdResult<RecoveryInfo> {
    match doc_id {
        None => {
            let mut orphaned = journal::scan_orphaned();
            orphaned.sort_by(|a, b| b.saved_at.cmp(&a.saved_at));
            Ok(match orphaned.into_iter().next() {
                Some(found) => RecoveryInfo {
                    available: true,
                    path: Some(found.path),
                    journal_id: Some(found.journal_id),
                    saved_at: Some(found.saved_at),
                },
                None => RecoveryInfo {
                    available: false,
                    path: None,
                    journal_id: None,
                    saved_at: None,
                },
            })
        }
        Some(doc_id) => {
            // Only `session.path()` needs the owner thread (a closed/unknown
            // document → "nothing to recover", the same unavailable answer as
            // before); the journal file read below is plain I/O.
            let Ok(path) = sessions.with_session(&doc_id, |session| session.path().to_path_buf())
            else {
                return Ok(RecoveryInfo {
                    available: false,
                    path: None,
                    journal_id: None,
                    saved_at: None,
                });
            };
            let journal_path = journal::Journal::path_for(&path).map_err(io_err)?;
            match journal::read(&journal_path).map_err(io_err)? {
                Some(contents) if !contents.commands.is_empty() => Ok(RecoveryInfo {
                    available: true,
                    path: Some(contents.original_path),
                    journal_id: journal_path
                        .file_stem()
                        .map(|s| s.to_string_lossy().into_owned()),
                    saved_at: Some(contents.last_activity_at),
                }),
                _ => Ok(RecoveryInfo {
                    available: false,
                    path: None,
                    journal_id: None,
                    saved_at: None,
                }),
            }
        }
    }
}
