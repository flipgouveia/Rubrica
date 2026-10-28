//! One module per IPC domain — CONTRACTS.md §3. Every command here is a thin
//! `#[tauri::command] #[specta::specta]` shell; wave-1+ agents replace bodies
//! inside their own module file only (CONTRACTS §6).

pub mod annotations;
pub mod app;
pub mod document;
pub mod forms;
pub mod history;
pub mod outline;
pub mod pages;
pub mod redact;
pub mod text;
pub mod textedit;
