//! The generic undo/redo machinery (CONTRACTS §3's `history_*` commands) —
//! see `src-tauri/API.md` for the full design writeup. This file defines the
//! `Command` trait every mutation (wave-2's annotations/pages/forms/textedit/
//! redact, and R2's own test-only commands below) implements, plus the
//! `CommandStack` that `engine::document::DocumentSession` embeds.
//!
//! `Command` is a trait, not an enum, specifically so wave-2 modules can add
//! new mutation types in their own files without ever touching this one.
//! `#[typetag::serde]` is what makes `Box<dyn Command>` itself serializable
//! (needed by `engine::journal`) without a hand-maintained registry: each
//! `impl Command for SomeStruct` self-registers a `"type"` tag at link time.

use pdfium_render::prelude::PdfDocument;

use crate::types::RubricaError;

/// One reversible mutation to a [`PdfDocument`]. See the module doc comment
/// and `API.md` for the contract wave-2 implementations must follow (plain
/// serializable data only — no PDFium handles, no borrowed data).
#[typetag::serde(tag = "type")]
pub trait Command: Send {
    /// Mutates `doc` forward, returning the 0-based page indices whose tiles
    /// are now stale. May record whatever state it needs for [`Self::revert`]
    /// into its own fields.
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError>;

    /// Undoes exactly what the last [`Self::apply`] call did, returning the
    /// same invalidated pages.
    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError>;
}

/// Owns the undo/redo stacks and the "how far since the last save" marker.
/// Deliberately knows nothing about the autosave journal or Tauri events —
/// `DocumentSession` (`engine::document`) composes this with `engine::journal`
/// and is what command handlers actually call.
#[derive(Default)]
pub struct CommandStack {
    undo_stack: Vec<Box<dyn Command>>,
    redo_stack: Vec<Box<dyn Command>>,
    saved_at_depth: usize,
}

impl CommandStack {
    pub fn new() -> Self {
        Self::default()
    }

    /// Applies `command`, pushes it to the undo stack, and clears the redo
    /// stack. Returns the invalidated pages on success; `command` is dropped
    /// (never pushed) if `apply` fails, since nothing was actually mutated.
    pub fn commit(
        &mut self,
        doc: &mut PdfDocument<'static>,
        mut command: Box<dyn Command>,
    ) -> Result<Vec<u32>, RubricaError> {
        let pages = command.apply(doc)?;
        self.undo_stack.push(command);
        self.redo_stack.clear();
        Ok(pages)
    }

    /// `Ok(None)` means there was nothing to undo — callers treat that as a
    /// no-op, not an error, matching `mock/history.ts`.
    pub fn undo(
        &mut self,
        doc: &mut PdfDocument<'static>,
    ) -> Result<Option<Vec<u32>>, RubricaError> {
        let Some(mut command) = self.undo_stack.pop() else {
            return Ok(None);
        };
        let pages = command.revert(doc)?;
        self.redo_stack.push(command);
        Ok(Some(pages))
    }

    /// `Ok(None)` means there was nothing to redo — see [`Self::undo`].
    pub fn redo(
        &mut self,
        doc: &mut PdfDocument<'static>,
    ) -> Result<Option<Vec<u32>>, RubricaError> {
        let Some(mut command) = self.redo_stack.pop() else {
            return Ok(None);
        };
        let pages = command.apply(doc)?;
        self.undo_stack.push(command);
        Ok(Some(pages))
    }

    /// The most recently committed (or redone) command, if any — used by
    /// `DocumentSession::commit` to hand the just-applied command to the
    /// journal for serialization without duplicating it.
    pub fn peek_undo(&self) -> Option<&dyn Command> {
        self.undo_stack.last().map(|b| b.as_ref())
    }

    pub fn can_undo(&self) -> bool {
        !self.undo_stack.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo_stack.is_empty()
    }

    pub fn dirty(&self) -> bool {
        self.undo_stack.len() != self.saved_at_depth
    }

    /// Call once a save has durably landed on disk.
    pub fn mark_saved(&mut self) {
        self.saved_at_depth = self.undo_stack.len();
    }

    /// Reverts every command committed since the last save, in reverse
    /// order, and clears the redo stack — used by `doc_close` on a dirty
    /// document (a deliberate close-without-saving discards edits, the same
    /// behavior `mock/state.ts::closeDoc` documents) and available to any
    /// future "revert to saved" affordance. Stops at the first `revert`
    /// failure, leaving whatever was already reverted popped (best-effort —
    /// the alternative is silently leaving stale commands on the stack,
    /// which would make the in-memory document *and* the undo stack agree
    /// on a wrong state).
    pub fn discard_unsaved(&mut self, doc: &mut PdfDocument<'static>) -> Result<(), RubricaError> {
        while self.undo_stack.len() > self.saved_at_depth {
            self.undo(doc)?;
        }
        self.redo_stack.clear();
        Ok(())
    }
}

/// Minimal, real `Command` implementations used only by this crate's own
/// tests (this module's own tests below, plus `tests/engine_fixtures.rs`)
/// to exercise the stack/journal/cache machinery before any wave-2 module
/// exists to provide real ones. Not part of the public IPC surface, and not
/// `#[cfg(test)]`-gated on purpose: `tests/engine_fixtures.rs` is a separate
/// integration-test binary that links `rubrica_lib` as an ordinary
/// (non-`#[cfg(test)]`) dependency, so anything only the *library's own*
/// test build compiled would not exist for it to call.
pub mod test_commands {
    use serde::{Deserialize, Serialize};

    use super::Command;
    use crate::types::RubricaError;
    use pdfium_render::prelude::*;

    /// Appends one blank page of the given size at the end of the document.
    #[derive(Debug, Serialize, Deserialize)]
    pub struct InsertBlankPageCommand {
        pub width: f32,
        pub height: f32,
        /// Recorded by `apply()` so `revert()` knows which page to remove —
        /// always `page_count - 1` at apply time, but spelling it out keeps
        /// the pattern every real wave-2 command will need to follow (stash
        /// undo data in `self` during `apply`) visible even in the simplest
        /// possible example.
        #[serde(skip)]
        inserted_at: Option<u32>,
    }

    impl InsertBlankPageCommand {
        pub fn new(width: f32, height: f32) -> Self {
            Self {
                width,
                height,
                inserted_at: None,
            }
        }
    }

    #[typetag::serde]
    impl Command for InsertBlankPageCommand {
        fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
            let index = doc.pages().len() as u32;
            doc.pages_mut()
                .create_page_at_end(PdfPagePaperSize::Custom(
                    PdfPoints::new(self.width),
                    PdfPoints::new(self.height),
                ))
                .map_err(|e| RubricaError::internal(e.to_string()))?;
            self.inserted_at = Some(index);
            Ok(vec![index])
        }

        fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
            let index = self
                .inserted_at
                .take()
                .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
            let page = doc
                .pages()
                .get(index as PdfPageIndex)
                .map_err(|e| RubricaError::internal(e.to_string()))?;
            page.delete()
                .map_err(|e| RubricaError::internal(e.to_string()))?;
            Ok(vec![index])
        }
    }

    /// Rotates one page by a relative number of degrees (normalized to one
    /// of 0/90/180/270), recording the previous rotation for `revert()`.
    #[derive(Debug, Serialize, Deserialize)]
    pub struct RotatePageCommand {
        pub page: u32,
        pub delta_degrees: i32,
        #[serde(skip)]
        previous: Option<i32>,
    }

    impl RotatePageCommand {
        pub fn new(page: u32, delta_degrees: i32) -> Self {
            Self {
                page,
                delta_degrees,
                previous: None,
            }
        }

        fn set_rotation(
            doc: &mut PdfDocument<'static>,
            page_index: u32,
            degrees: i32,
        ) -> Result<(), RubricaError> {
            let mut page = doc
                .pages()
                .get(page_index as PdfPageIndex)
                .map_err(|e| RubricaError::internal(e.to_string()))?;
            page.set_rotation(crate::engine::pdfium::degrees_to_rotation(degrees));
            Ok(())
        }
    }

    #[typetag::serde]
    impl Command for RotatePageCommand {
        fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
            let page = doc
                .pages()
                .get(self.page as PdfPageIndex)
                .map_err(|e| RubricaError::internal(e.to_string()))?;
            let before = crate::engine::pdfium::rotation_to_degrees(
                page.rotation()
                    .map_err(|e| RubricaError::internal(e.to_string()))?,
            );
            self.previous = Some(before);
            drop(page);
            Self::set_rotation(doc, self.page, before + self.delta_degrees)?;
            Ok(vec![self.page])
        }

        fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
            let before = self
                .previous
                .take()
                .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
            Self::set_rotation(doc, self.page, before)?;
            Ok(vec![self.page])
        }
    }
}
