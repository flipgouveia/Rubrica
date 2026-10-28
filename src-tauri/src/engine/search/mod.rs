//! Search v2 engine (CONTRACTS v1.2.0 §3, `agents/SEARCH-ORCHESTRATION.md` §2.2).
//!
//! Search no longer goes through `FPDFText_Find*`. Instead:
//!
//! 1. [`extract`] reads one page's characters and lines out of PDFium. It is the
//!    ONLY part of this module tree that touches PDFium, so it only ever runs on
//!    the PDFium owner thread (inside `SessionStore::with_session`).
//! 2. [`index`] turns a [`RawPage`] into a compact, cached [`index::PageIndex`]
//!    (original text, char boxes, normalized text + map back to original chars).
//! 3. [`furniture`] detects running headers/footers from every page's lines.
//! 4. [`scope`] resolves a `SearchScope` to a page range, and maps pages to
//!    outline entries.
//! 5. [`matcher`] runs phrase / proximity matching over the page indexes. It is
//!    pure Rust over already-extracted data and runs on the search task, never
//!    on the PDFium thread.
//!
//! The pipeline that ties these together (`run_search`) lives in
//! `commands/text.rs`. Module ownership during wave F2: `index`, `normalize`,
//! `matcher` → S3; `scope` (+ `engine/outline.rs`) → S4; `furniture` → S5;
//! this file and `extract` → the orchestrator (frozen for the wave).

pub mod extract;
pub mod furniture;
pub mod index;
pub mod matcher;
pub mod normalize;
pub mod pipeline;
pub mod scope;

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Arc;

/// A box in PDF points (origin bottom-left, like `types::Rect`), stored as
/// `f32` to keep the index small.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct BoxF {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}

impl BoxF {
    pub fn right(&self) -> f32 {
        self.x + self.w
    }

    pub fn top(&self) -> f32 {
        self.y + self.h
    }

    /// Smallest box containing both.
    pub fn union(&self, other: &BoxF) -> BoxF {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        BoxF {
            x,
            y,
            w: self.right().max(other.right()) - x,
            h: self.top().max(other.top()) - y,
        }
    }

    pub fn to_rect(self) -> crate::types::Rect {
        crate::types::Rect {
            x: self.x as f64,
            y: self.y as f64,
            width: self.w as f64,
            height: self.h as f64,
        }
    }
}

/// One character as PDFium reports it, in `text_page_layout`'s `char_index`
/// space (index in [`RawPage::chars`] == PDFium char index).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RawChar {
    /// U+FFFD when PDFium has no Unicode mapping for the glyph.
    pub ch: char,
    /// `None` for chars PDFium cannot box (typically generated `\r`/`\n`/spaces).
    pub bbox: Option<BoxF>,
    /// Inserted by PDFium's text layout (line breaks, word spaces), not drawn.
    pub generated: bool,
}

/// One visual line of a page: a contiguous char range plus the union of its
/// char boxes. The range excludes the line-break chars that end it.
#[derive(Debug, Clone, PartialEq)]
pub struct TextLine {
    pub chars: Range<u32>,
    pub rect: BoxF,
}

/// Everything search needs from one page, extracted in a single pass on the
/// PDFium thread. Transient: [`index::PageIndex`] is what gets cached.
#[derive(Debug, Clone, PartialEq)]
pub struct RawPage {
    pub page: u32,
    pub width: f32,
    pub height: f32,
    pub chars: Vec<RawChar>,
    pub lines: Vec<TextLine>,
}

/// A line's text plus where it is: the input to header/footer detection.
#[derive(Debug, Clone, PartialEq)]
pub struct LineText {
    pub text: String,
    pub chars: Range<u32>,
    pub rect: BoxF,
}

/// One page's lines, as [`furniture::detect`] consumes them.
#[derive(Debug, Clone, PartialEq)]
pub struct PageLines {
    pub page: u32,
    pub height: f32,
    pub lines: Vec<LineText>,
}

/// Per-document search cache, owned by `DocumentSession` (so it lives and dies
/// on the PDFium thread with the document, and is dropped by `doc_close`).
/// `PageIndex`/`Furniture` are behind `Arc` so the search task can take them
/// off the PDFium thread and match without holding the session.
#[derive(Default)]
pub struct SearchCache {
    pages: HashMap<u32, Arc<index::PageIndex>>,
    furniture: Option<Arc<furniture::Furniture>>,
}

impl SearchCache {
    pub fn page(&self, page: u32) -> Option<Arc<index::PageIndex>> {
        self.pages.get(&page).cloned()
    }

    pub fn insert_page(&mut self, page: u32, index: Arc<index::PageIndex>) {
        self.pages.insert(page, index);
    }

    pub fn furniture(&self) -> Option<Arc<furniture::Furniture>> {
        self.furniture.clone()
    }

    pub fn set_furniture(&mut self, furniture: Arc<furniture::Furniture>) {
        self.furniture = Some(furniture);
    }

    /// Drops the listed pages' indexes. Header/footer detection depends on
    /// every page, so any invalidation drops it too.
    pub fn invalidate(&mut self, pages: &[u32]) {
        if pages.is_empty() {
            return;
        }
        for page in pages {
            self.pages.remove(page);
        }
        self.furniture = None;
    }

    pub fn clear(&mut self) {
        self.pages.clear();
        self.furniture = None;
    }

    /// Approximate heap use of the cached indexes (memory budget, §2.2).
    pub fn heap_bytes(&self) -> usize {
        self.pages.values().map(|index| index.heap_bytes()).sum()
    }
}
