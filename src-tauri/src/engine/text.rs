//! Text layer — CONTRACTS §3's `text` domain, backing `commands/text.rs`: per-page character
//! boxes (`text_page_layout`), text extraction by char range (`text_extract_range`) and the
//! cancellation registry for in-flight searches. The search itself lives in `engine::search`
//! (`pipeline::{prepare, run}`); the `tauri::async_runtime` task that streams `search_batch`
//! events is in `commands/text.rs`, since this module (like the rest of `engine/`) never imports
//! `tauri`. See `src-tauri/API.md`'s "Text layer & search" section.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use pdfium_render::prelude::*;

use crate::engine::document::DocumentSession;
use crate::types::{CharBox, Rect, RubricaError, SearchId};

fn rect_to_dto(rect: PdfRect) -> Rect {
    Rect {
        x: rect.left().value as f64,
        y: rect.bottom().value as f64,
        width: rect.width().value as f64,
        height: rect.height().value as f64,
    }
}

/// One [`CharBox`] per character on `page` whose bounds PDFium can compute.
/// A handful of generated/zero-width glyphs can fail `tight_bounds()` (and
/// even `loose_bounds()`) — those are skipped rather than erroring the
/// whole page, so `char_index` is not guaranteed contiguous.
pub fn page_layout(session: &DocumentSession, page: u32) -> Result<Vec<CharBox>, RubricaError> {
    let pdf_page = get_page(session, page)?;
    let text = pdf_page
        .text()
        .map_err(|e| RubricaError::internal(e.to_string()))?;
    let chars = text.chars();

    let mut boxes = Vec::new();
    for index in 0..chars.len() {
        let Ok(char) = chars.get(index) else { continue };
        let rect = char.tight_bounds().or_else(|_| char.loose_bounds()).ok();
        if let Some(rect) = rect {
            boxes.push(CharBox {
                char_index: index as u32,
                rect: rect_to_dto(rect),
            });
        }
    }
    Ok(boxes)
}

/// The substring of `page`'s extracted text in `[start, end)`, clamped to
/// the page's actual character count.
pub fn extract_range(
    session: &DocumentSession,
    page: u32,
    start: u32,
    end: u32,
) -> Result<String, RubricaError> {
    if end < start {
        return Err(RubricaError::invalid_arg("range end precedes start"));
    }
    let pdf_page = get_page(session, page)?;
    let text = pdf_page
        .text()
        .map_err(|e| RubricaError::internal(e.to_string()))?;
    let chars = text.chars();
    let len = chars.len() as u32;
    if start > len {
        return Err(RubricaError::invalid_arg(format!(
            "range start {start} is past the end of page {page} ({len} chars)"
        )));
    }

    let mut out = String::new();
    for index in start..end.min(len) {
        if let Ok(char) = chars.get(index as usize) {
            if let Some(ch) = char.unicode_char() {
                out.push(ch);
            }
        }
    }
    Ok(out)
}

/// Registers a client-minted `search_id`; `INVALID_ARG` when that id is
/// already running.
pub fn register_search(
    registry: &SearchRegistry,
    search_id: &str,
) -> Result<Arc<AtomicBool>, RubricaError> {
    registry.register(search_id).ok_or_else(|| {
        RubricaError::invalid_arg(format!("search \"{search_id}\" is already running"))
    })
}

pub fn page_count(session: &DocumentSession) -> u32 {
    session.document().pages().len() as u32
}

fn get_page<'a>(session: &'a DocumentSession, page: u32) -> Result<PdfPage<'a>, RubricaError> {
    session
        .document()
        .pages()
        .get(page as PdfPageIndex)
        .map_err(|e| RubricaError::invalid_arg(e.to_string()))
}

/// Cancellation flags for in-flight searches, keyed by [`SearchId`].
/// `.manage()`d in `lib.rs`; `commands/text.rs`'s `text_search_cancel` sets
/// the flag and removes the entry, and the background search task checks it
/// between pages — see the module doc comment.
#[derive(Default)]
pub struct SearchRegistry(Mutex<HashMap<SearchId, Arc<AtomicBool>>>);

impl SearchRegistry {
    /// Registers the client-minted `search_id` (CONTRACTS v1.1.0) with an
    /// initially `false` cancellation flag. `None` if that id is already
    /// running.
    pub fn register(&self, search_id: &str) -> Option<Arc<AtomicBool>> {
        let mut map = self.0.lock().ok()?;
        if map.contains_key(search_id) {
            return None;
        }
        let flag = Arc::new(AtomicBool::new(false));
        map.insert(search_id.to_owned(), flag.clone());
        Some(flag)
    }

    /// Marks `search_id` cancelled and stops tracking it. A cancel for an
    /// unknown/already-finished id is a silent no-op, matching
    /// `mock/text.ts::textSearchCancel`.
    pub fn cancel(&self, search_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            if let Some(flag) = map.remove(search_id) {
                flag.store(true, Ordering::Relaxed);
            }
        }
    }

    /// Called once a search naturally finishes (not cancelled) so its flag
    /// doesn't linger in the map forever.
    pub fn finish(&self, search_id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(search_id);
        }
    }
}
