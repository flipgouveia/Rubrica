//! Rubrica's Tauri app spine: wires the full CONTRACTS §3 command surface
//! through tauri-specta (so `src/ipc/bindings.ts` is generated, never
//! hand-written), registers the `rubrica-tile://`/`rubrica-thumb://` custom
//! protocols (CONTRACTS §3), and mounts the CONTRACTS §4 event types.
//!
//! This file, the specta builder, and protocol registration are frozen after
//! wave 1 (CONTRACTS §6) — wave-2 agents replace stub bodies inside their own
//! `commands/`/`engine/` module files only.

pub mod commands;
pub mod engine;
pub mod os_integration;
pub mod protocols;
pub mod store;
pub mod types;

use tauri::Manager;
use tauri_specta::{collect_commands, collect_events, Builder, Event};

use engine::document::SessionStore;
use engine::text::SearchRegistry;
use engine::tiles::TileCache;
use types::{DocStateChanged, RecoveryAvailable, SaveStateChanged, SearchBatch};

/// Builds the tauri-specta command/event registry. Shared between the real
/// app (`run`, below) and `tests/export_bindings.rs`, which calls `.export()`
/// on it without ever launching a window — that's how `pnpm
/// bindings:generate` regenerates `src/ipc/bindings.ts` in CI and locally.
pub fn specta_builder() -> Builder<tauri::Wry> {
    Builder::<tauri::Wry>::new()
        .commands(collect_commands![
            // document
            commands::document::doc_open,
            commands::document::doc_close,
            commands::document::doc_save,
            commands::document::doc_save_as,
            commands::document::doc_list_open,
            // outline (CONTRACTS v1.2.0)
            commands::outline::doc_outline,
            // text
            commands::text::text_page_layout,
            commands::text::text_extract_range,
            commands::text::text_search_start,
            commands::text::text_search_cancel,
            // history
            commands::history::history_undo,
            commands::history::history_redo,
            commands::history::history_state,
            // annotations
            commands::annotations::annot_list,
            commands::annotations::annot_add,
            commands::annotations::annot_update,
            commands::annotations::annot_delete,
            // pages
            commands::pages::pages_reorder,
            commands::pages::pages_rotate,
            commands::pages::pages_delete,
            commands::pages::pages_insert_blank,
            commands::pages::pages_insert_from_file,
            // forms
            commands::forms::form_fields,
            commands::forms::form_set_value,
            // textedit
            commands::textedit::text_objects,
            commands::textedit::textobj_set_text,
            commands::textedit::textobj_add,
            commands::textedit::imageobj_add,
            commands::textedit::object_delete,
            // redact
            commands::redact::redact_apply,
            // app
            commands::app::recents_list,
            commands::app::recents_clear,
            commands::app::prefs_get,
            commands::app::prefs_set,
            commands::app::print_render,
            commands::app::journal_recover,
        ])
        .events(collect_events![
            DocStateChanged,
            SaveStateChanged,
            SearchBatch,
            RecoveryAvailable,
        ])
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = specta_builder();

    #[cfg(debug_assertions)]
    builder
        .export(
            specta_typescript::Typescript::default(),
            "../src/ipc/bindings.ts",
        )
        .expect("failed to export TypeScript bindings");

    let store = store::Store::open().expect("failed to open the local SQLite store");
    let portable = os_integration::is_portable();

    let mut app_builder = tauri::Builder::default()
        // Per tauri-plugin-single-instance's own docs, this must be the
        // first plugin registered. It focuses the running window and routes
        // a relaunch's argv (a file-association double-click, or the Jump
        // List's "New window" task) — see `os_integration::handle_relaunch`.
        .plugin(tauri_plugin_single_instance::init(
            os_integration::handle_relaunch,
        ))
        // Native Open/Save pickers for the Home screen's "Browse" and the
        // toolbar's "Save As" (see src/chrome/filePicker.ts). Registered
        // unconditionally — both builds need to open and save files.
        .plugin(tauri_plugin_dialog::init())
        .manage(std::sync::Mutex::new(store))
        .manage(SessionStore::default())
        .manage(TileCache::default())
        .manage(SearchRegistry::default())
        .manage(os_integration::pending_open_from_cold_start());

    // Deliverable 4 ("disabled cleanly in the portable build"): the
    // portable .exe never registers the updater plugin at all, so the
    // frontend's `check()` call rejects (unknown command) instead of ever
    // reaching a network endpoint or offering to overwrite a portable copy
    // it doesn't own the location of.
    if !portable {
        app_builder = app_builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    app_builder
        .invoke_handler(builder.invoke_handler())
        .setup(move |app| {
            builder.mount_events(app);

            // Bind Pdfium once, ON the `SessionStore` owner thread rather than
            // here on the setup/main thread: PDFium's library-global init
            // (`FPDF_InitLibrary`, plus its font-cache state) must happen on
            // the same thread every later `FPDF_LoadDocument`/render/
            // `FPDF_CloseDocument` runs on — that single thread identity is the
            // whole point of the actor (see `SessionStore`'s doc comment and
            // `agents/reports/r2-report.md`). `with_store` blocks until the
            // owner thread has bound it, so binding is done before any command
            // can ask for a document. Still prefers the production resource
            // directory (where `tauri.conf.json`'s `bundle.resources` places
            // `pdfium.dll`) before `engine::pdfium`'s other fallbacks.
            commands::app::clear_all_print_renders();

            let resource_dir = app.path().resource_dir().ok();
            let _ = app.state::<SessionStore>().with_store(move |_| {
                engine::pdfium::shared_with(resource_dir);
            });

            // Startup crash-recovery scan (CONTRACTS §8/§4): every journal
            // file found here is orphaned by definition — nothing has had
            // a chance to open a session (and attach to one) yet. See
            // `src-tauri/API.md`'s "Autosave journal" section.
            for orphan in engine::journal::scan_orphaned() {
                let _ = RecoveryAvailable {
                    path: orphan.path,
                    journal_id: orphan.journal_id,
                    saved_at: orphan.saved_at,
                }
                .emit(app);
            }

            // R7: frontend-ready handshake (delivers a cold-start file-open
            // path) and the taskbar Jump List — see os_integration.rs.
            os_integration::init(app);

            Ok(())
        })
        // Asynchronous, not the synchronous variant: the handler only parses
        // the URL and hands the render to a dedicated thread, so PDFium and
        // PNG encoding never run on WebView2's UI thread (which would stall
        // input/IPC) — see protocols.rs's threading doc comment.
        .register_asynchronous_uri_scheme_protocol("rubrica-tile", |ctx, request, responder| {
            protocols::handle_tile_request(ctx.app_handle().clone(), request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("rubrica-thumb", |ctx, request, responder| {
            protocols::handle_thumb_request(ctx.app_handle().clone(), request, responder);
        })
        .register_asynchronous_uri_scheme_protocol("rubrica-print", |_ctx, request, responder| {
            protocols::handle_print_request(request, responder);
        })
        .run(tauri::generate_context!())
        .expect("error while running the Rubrica application");
}
