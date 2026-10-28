//! Engine modules mirror `commands/` one-to-one (CONTRACTS §6) — this is where
//! the real PDFium-backed logic lives once wave-1+ agents replace the command
//! stubs. `pdfium` and `tiles` are the two exceptions the command mirror
//! doesn't cover: `pdfium` is the shared runtime-binding helper (real as of
//! wave 0 — see `pdfium.rs` and `tests/pdfium_smoke.rs`), and `tiles` backs
//! the `rubrica-tile://`/`rubrica-thumb://` protocols (CONTRACTS §3) rather
//! than a command.

pub mod annotations;
pub mod document;
pub mod forms;
pub mod history;
pub mod journal;
pub mod outline;
pub mod pages;
pub mod pdfium;
pub mod redact;
pub mod search;
pub mod text;
pub mod textedit;
pub mod tiles;
