//! Shared IPC types — CONTRACTS.md §2 and the per-domain types referenced in §3.
//!
//! This is the single source of truth: `specta` reads these definitions (and the
//! `#[tauri::command]` signatures that use them) to generate `src/ipc/bindings.ts`.
//! Never hand-edit the generated file — regenerate it (`pnpm bindings:generate`)
//! and let the CI drift check confirm it matches.
//!
//! Field names are `camelCase` on the wire (matching CONTRACTS' TypeScript types)
//! via `#[serde(rename_all = "camelCase")]`; specta's serde integration carries
//! that renaming through to the generated TS.

use serde::{Deserialize, Serialize};
use specta::Type;

pub type DocId = String;
pub type AnnotId = String;
pub type ObjectId = String;
pub type FieldId = String;
pub type SearchId = String;

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub doc_id: DocId,
    pub path: String,
    pub page_count: u32,
    /// PDF points, one entry per page.
    pub pages: Vec<PageSize>,
    pub encrypted: bool,
    pub dirty: bool,
    pub revision: u32,
    pub has_form: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub revision: u32,
    pub invalidated_pages: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RubricaErrorCode {
    Encrypted,
    Corrupt,
    Io,
    NotFound,
    Unsupported,
    FontMissing,
    InvalidArg,
    Internal,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, thiserror::Error)]
#[error("{code:?}: {message}")]
pub struct RubricaError {
    pub code: RubricaErrorCode,
    pub message: String,
}

impl RubricaError {
    pub fn unsupported(command: &str) -> Self {
        Self {
            code: RubricaErrorCode::Unsupported,
            message: format!("{command} is not yet implemented (wave-0 stub)"),
        }
    }

    pub fn invalid_arg(message: impl Into<String>) -> Self {
        Self {
            code: RubricaErrorCode::InvalidArg,
            message: message.into(),
        }
    }

    pub fn io(message: impl Into<String>) -> Self {
        Self {
            code: RubricaErrorCode::Io,
            message: message.into(),
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self {
            code: RubricaErrorCode::Internal,
            message: message.into(),
        }
    }

    pub fn encrypted(message: impl Into<String>) -> Self {
        Self {
            code: RubricaErrorCode::Encrypted,
            message: message.into(),
        }
    }

    pub fn corrupt(message: impl Into<String>) -> Self {
        Self {
            code: RubricaErrorCode::Corrupt,
            message: message.into(),
        }
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self {
            code: RubricaErrorCode::NotFound,
            message: message.into(),
        }
    }
}

pub type CmdResult<T> = Result<T, RubricaError>;

// --- history -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HistoryState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub dirty: bool,
}

// --- text ----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRange {
    pub page: u32,
    pub start: u32,
    pub end: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CharBox {
    pub char_index: u32,
    pub rect: Rect,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Phrase = the whole text as one sequence; proximity = every term within a
/// window of characters (CONTRACTS v1.2.0 §3).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SearchMode {
    Phrase,
    Proximity,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ProximityOptions {
    /// Maximum window length in characters (20–5000; the UI default is 500).
    pub window: u32,
}

/// Which pages a search covers. Page numbers are 0-based and inclusive.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SearchScope {
    All,
    Pages {
        from: u32,
        to: u32,
    },
    #[serde(rename_all = "camelCase")]
    Outline {
        item_id: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchQuery {
    pub text: String,
    pub mode: SearchMode,
    /// Required when `mode` is `proximity`, ignored otherwise.
    pub proximity: Option<ProximityOptions>,
    pub scope: SearchScope,
    pub case_sensitive: bool,
    pub whole_word: bool,
    pub ignore_diacritics: bool,
    pub exclude_headers_footers: bool,
}

/// All hits that START on one page (CONTRACTS v1.2.0 §3).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub page: u32,
    pub hits: Vec<SearchHit>,
}

/// One highlighted run: a term (or phrase) occurrence on one line of one page.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct HitRect {
    /// The page this rect is on — differs from `SearchMatch.page` only for
    /// the second page of a hit that spans a page break.
    pub page: u32,
    pub rect: Rect,
    /// 0-based position of the term in the query (phrase mode: always 0).
    pub term: u8,
}

/// A rect on a given page (window outlines, header/footer furniture).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageRect {
    pub page: u32,
    pub rect: Rect,
}

/// One result. Phrase mode: one occurrence of the text. Proximity mode: one
/// window ("zone") holding every term. Either may wrap across lines and, at
/// most, continue onto the next page.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub rects: Vec<HitRect>,
    /// Start and length in the START page's `text_page_layout` `char_index`
    /// space; for a hit that spans pages, the length stops at that page's end.
    pub char_start: u32,
    pub char_len: u32,
    pub context: SearchContext,
    /// Proximity only: the soft outline around the whole window, one rect per
    /// line (empty in phrase mode).
    pub window_rects: Vec<PageRect>,
    /// Proximity only: window length in characters (lower = more compact).
    pub score: Option<u32>,
    /// `[startPage, endPage]` when the hit continues onto the next page.
    pub spans_pages: Option<(u32, u32)>,
    /// Deepest outline entry containing the start page (`None` without an outline).
    pub outline_item_id: Option<String>,
}

/// ~60 chars either side of the match, whitespace collapsed to single spaces.
/// In proximity mode `matched` is the window text, elided in the middle with
/// " … " when it is longer than 160 chars; `terms` lists the char ranges of
/// each term inside `matched` so the list can colour them.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SearchContext {
    pub before: String,
    pub matched: String,
    pub after: String,
    pub terms: Vec<ContextTerm>,
}

/// A term occurrence inside `SearchContext.matched` (UTF-16 offsets, so the
/// UI can slice the JS string directly).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ContextTerm {
    pub start: u32,
    pub len: u32,
    pub term: u8,
}

/// One entry of the document outline (bookmarks). Pages are 0-based.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct OutlineItem {
    /// Stable for a given document revision: the path of child indexes from
    /// the root, e.g. `"2.1"` for the second child of the third root entry.
    pub id: String,
    pub title: String,
    /// `None` when the entry has no resolvable destination page.
    pub page: Option<u32>,
    /// Last page of the entry's range (inclusive): the page before the next
    /// entry of the same or a higher level, or the last page of the document.
    pub page_end: Option<u32>,
    pub depth: u32,
    pub children: Vec<OutlineItem>,
}

/// Header/footer lines excluded on one page (`excludeHeadersFooters`).
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageFurniture {
    pub page: u32,
    pub rects: Vec<Rect>,
}

// --- annotations -----------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct QuadPoint {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub x3: f64,
    pub y3: f64,
    pub x4: f64,
    pub y4: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Stroke {
    pub points: Vec<Point>,
    pub width: f64,
    /// `#rrggbb`.
    pub color: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ShapeKind {
    Rect,
    Ellipse,
    Line,
    Arrow,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct StrokeFill {
    /// `#rrggbb`, absent means no stroke/fill.
    pub color: Option<String>,
    pub opacity: f64,
    pub width: Option<f64>,
}

/// CONTRACTS §3's union is literally `highlight | underline | strikeout | ink
/// | note | shape | freeText` — three separate markup variants sharing a
/// shape, not one `markup` variant with a kind field. `#[serde(rename_all =
/// "camelCase")]` on the enum itself only renames variant *names*; it does
/// NOT cascade into each variant's own fields (that's serde's documented
/// behavior, not a bug here), so every struct-like variant repeats the
/// attribute for its own fields.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AnnotSpec {
    #[serde(rename_all = "camelCase")]
    Highlight {
        page: u32,
        quadpoints: Vec<QuadPoint>,
        color: String,
        opacity: f64,
    },
    #[serde(rename_all = "camelCase")]
    Underline {
        page: u32,
        quadpoints: Vec<QuadPoint>,
        color: String,
        opacity: f64,
    },
    #[serde(rename_all = "camelCase")]
    Strikeout {
        page: u32,
        quadpoints: Vec<QuadPoint>,
        color: String,
        opacity: f64,
    },
    #[serde(rename_all = "camelCase")]
    Ink {
        page: u32,
        strokes: Vec<Stroke>,
        opacity: f64,
    },
    #[serde(rename_all = "camelCase")]
    Note {
        page: u32,
        point: Point,
        contents: String,
    },
    #[serde(rename_all = "camelCase")]
    Shape {
        page: u32,
        shape: ShapeKind,
        rect: Rect,
        stroke: StrokeFill,
        fill: StrokeFill,
    },
    #[serde(rename_all = "camelCase")]
    FreeText {
        page: u32,
        rect: Rect,
        text: String,
        font_size: f64,
        color: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Annot {
    pub annot_id: AnnotId,
    pub page: u32,
    #[serde(flatten)]
    pub spec: AnnotSpec,
}

/// A partial update to an existing annotation; every field optional.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AnnotPatch {
    pub color: Option<String>,
    pub opacity: Option<f64>,
    pub contents: Option<String>,
    pub rect: Option<Rect>,
}

// --- pages -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct BlankPageSpec {
    pub width: f64,
    pub height: f64,
}

/// Inclusive 0-based page range within a *source* file being inserted from —
/// distinct from [`TextRange`], which is a char range within one page.
#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct PageRange {
    pub start: u32,
    pub end: u32,
}

// --- forms -----------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum FormFieldKind {
    Text,
    Checkbox,
    Radio,
    Combo,
    Listbox,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct FormField {
    pub id: FieldId,
    pub page: u32,
    pub rect: Rect,
    pub kind: FormFieldKind,
    pub value: String,
    pub options: Option<Vec<String>>,
    pub read_only: bool,
    pub required: bool,
}

// --- textedit --------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextRun {
    pub object_id: ObjectId,
    pub rect: Rect,
    pub text: String,
    pub font_name: String,
    pub font_size: f64,
    pub embedded_font_usable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SetTextResult {
    #[serde(flatten)]
    pub mutation: MutationResult,
    pub font_substituted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct TextObjectSpec {
    pub rect: Rect,
    pub text: String,
    pub font_size: f64,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct ImageObjectSpec {
    pub rect: Rect,
    pub path: String,
}

// --- app -----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecentDoc {
    pub path: String,
    pub last_opened_at: String,
    pub last_page: u32,
    pub last_zoom: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryInfo {
    pub available: bool,
    pub path: Option<String>,
    pub journal_id: Option<String>,
    pub saved_at: Option<String>,
}

// --- events ----------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "doc_state_changed")]
pub struct DocStateChanged {
    pub doc_id: DocId,
    pub revision: u32,
    pub dirty: bool,
    pub invalidated_pages: Vec<u32>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Type)]
#[serde(rename_all = "lowercase")]
pub enum SaveState {
    Dirty,
    Saving,
    Saved,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "save_state")]
pub struct SaveStateChanged {
    pub doc_id: DocId,
    pub state: SaveState,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "search_batch")]
pub struct SearchBatch {
    pub search_id: SearchId,
    pub matches: Vec<SearchMatch>,
    pub done: bool,
    /// Pages finished so far; equals `page_count` on the `done` batch.
    pub pages_searched: u32,
    pub page_count: u32,
    /// Only meaningful when `done`: no searched page had extractable text.
    pub textless: bool,
    /// `true` only on a proximity `done` batch: every hit's `score` is final,
    /// so the UI may now switch from document order to compactness order
    /// (it sorts by `score` itself; nothing is re-sent).
    pub ranked: bool,
    /// With `excludeHeadersFooters`: the excluded lines on this batch's pages.
    pub furniture: Vec<PageFurniture>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Type, tauri_specta::Event)]
#[serde(rename_all = "camelCase")]
#[tauri_specta(event_name = "recovery_available")]
pub struct RecoveryAvailable {
    pub path: String,
    pub journal_id: String,
    pub saved_at: String,
}
