//! In-place text-run editing (font reuse, substitution flag, no reflow) and
//! text-box/image-object insertion — R6's module. See `src-tauri/API.md`'s
//! `engine::history` section for the `Command` contract this builds on.
//!
//! ## Object identity
//!
//! PDFium page objects have no stable id of their own, so a `TextRun.objectId` here is just
//! `"<page>:<index>"` — the object's position within `page.objects()` at the moment
//! [`list_text_runs`] was called. Editing a run in place never changes indices; deleting or
//! redacting one does (later objects shift down), which is why every mutation here re-fetches
//! by index *inside* the same `apply()`/`revert()` call rather than caching it — a caller that
//! deletes or redacts a page should treat every previously-fetched id for that page as stale
//! and re-request [`list_text_runs`].
//!
//! ## A pdfium-render 0.9.3 gap: text edits don't auto-regenerate content
//!
//! Every mutation that adds, removes, or transforms a page object routes through the crate's
//! internal `regenerate_content_after_mutation()` (confirmed by reading the vendored source:
//! `pdf/document/page/object/private.rs`), which calls `FPDFPage_GenerateContent` immediately
//! under the page's default `AutomaticOnEveryChange` strategy. `PdfPageTextObject::set_text()`
//! does **not** — it calls `FPDFText_SetText_str` directly and returns, with no regeneration
//! hook at all (nor does the crate's page-level "regenerate on drop" fallback ever fire: its
//! `is_content_regeneration_required` flag is initialized `false` and is never set `true`
//! anywhere in 0.9.3 — effectively dead code). Left alone, an edited run's new text would be
//! invisible to `FPDFText_LoadPage` (so even our own round-trip check below would read stale
//! text) and would never make it into the saved file's content stream. Every place in this
//! module that calls `set_text()` follows it with an explicit `page.regenerate_content()`.
//!
//! ## Font reuse vs. substitution
//!
//! [`SetTextCommand::apply`] decides by *doing* the edit and checking behaviorally, not by
//! inspecting glyph tables: set the run's text, regenerate content, read it back through
//! PDFium's own text layer, and compare. This works uniformly for a truly embedded (subsetted)
//! font *and* for a standard, non-embedded base-14 font (PDFium's own encoding tables decide
//! what round-trips) without needing to parse font programs ourselves. If the round trip
//! matches, the run keeps its original font resource (reused via a [`PdfFontToken`], not
//! reconstructed); if not, the run is replaced with a new object using a standard substitute
//! font chosen by [`guess_builtin`] from the original font's name/weight/italic angle, and
//! `fontSubstituted: true` is reported back.
//!
//! ## A real crash, and the safety boundary this module enforces because of it
//!
//! Every "simple" (non-CID) PDF font — every one of the 14 standard fonts, and the large
//! majority of embedded fonts too — can only ever address 256 distinct character codes. Asking
//! the vendored chromium/8035 PDFium build to encode a codepoint no simple font's encoding can
//! reach at all (confirmed empirically: a CJK string against a standard, WinAnsi-encoded
//! Helvetica run) doesn't fail gracefully — `FPDFText_SetText_str` crashes the whole process
//! outright (`STATUS_ILLEGAL_INSTRUCTION`, no Rust panic, nothing `catch_unwind` can intercept).
//! [`ensure_winansi_encodable`] rejects such text up front, before either the reuse attempt or
//! a substitute-font rebuild ever calls `set_text`/`create_text_object` — a substitute standard
//! font couldn't represent a non-Latin script any better anyway (none of the 14 base fonts use
//! anything but a WinAnsi-family single-byte encoding), so this isn't a coverage gap the
//! substitution mechanism is meant to paper over; it's simply outside what text editing supports
//! in this version, the same way the rest of Rubrica has no CJK story either.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::document::DocumentSession;
use crate::engine::history::Command;
use crate::types::{ImageObjectSpec, ObjectId, Rect, RubricaError, TextObjectSpec, TextRun};

/// Maps a PDFium call failure to a generic internal error — used for calls that "shouldn't
/// normally fail" once arguments are already known-valid (mirrors the convention already used
/// throughout `commands/`/`engine/`).
pub(crate) fn pdfium_err(e: PdfiumError) -> RubricaError {
    RubricaError::internal(e.to_string())
}

/// Fetches a page, mapping a bad page index to `INVALID_ARG` — matches `engine::text::get_page`'s
/// convention (a separate private copy there; this one is `pub(crate)` so `engine::redact` can
/// share it too).
pub(crate) fn get_page(
    doc: &PdfDocument<'static>,
    page: u32,
) -> Result<PdfPage<'static>, RubricaError> {
    doc.pages()
        .get(page as PdfPageIndex)
        .map_err(|e| RubricaError::invalid_arg(e.to_string()))
}

pub(crate) fn format_object_id(page: u32, index: usize) -> ObjectId {
    format!("{page}:{index}")
}

pub(crate) fn parse_object_id(id: &str) -> Result<(u32, usize), RubricaError> {
    let (page_str, index_str) = id
        .split_once(':')
        .ok_or_else(|| RubricaError::invalid_arg(format!("malformed object id \"{id}\"")))?;
    let page = page_str
        .parse::<u32>()
        .map_err(|_| RubricaError::invalid_arg(format!("malformed object id \"{id}\"")))?;
    let index = index_str
        .parse::<usize>()
        .map_err(|_| RubricaError::invalid_arg(format!("malformed object id \"{id}\"")))?;
    Ok((page, index))
}

fn rect_to_dto(rect: &PdfRect) -> Rect {
    Rect {
        x: rect.left().value as f64,
        y: rect.bottom().value as f64,
        width: rect.width().value as f64,
        height: rect.height().value as f64,
    }
}

fn color_from_hex(hex: &str) -> Result<PdfColor, RubricaError> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 {
        return Err(RubricaError::invalid_arg(format!(
            "expected a #rrggbb color, got \"{hex}\""
        )));
    }
    let byte = |slice: &str| {
        u8::from_str_radix(slice, 16)
            .map_err(|_| RubricaError::invalid_arg(format!("invalid color \"{hex}\"")))
    };
    Ok(PdfColor::new(
        byte(&hex[0..2])?,
        byte(&hex[2..4])?,
        byte(&hex[4..6])?,
        255,
    ))
}

/// Every Unicode codepoint reachable through the PDF standard fonts' WinAnsiEncoding (the
/// Windows-1252 single-byte encoding CONTRACTS' own PT-PT fixture relies on — see
/// `fixtures/generate.mjs`'s `unicode.pdf` comment) — bytes 0x20-0x7E and 0xA0-0xFF map to the
/// identical Unicode codepoint; the scattered 0x80-0x9F block below is Windows-1252's own
/// "smart punctuation" run. See the module doc comment's crash writeup for why this exists as a
/// hard safety boundary, not just a coverage nicety.
fn is_winansi_representable(c: char) -> bool {
    matches!(
        c as u32,
        0x09 | 0x0A | 0x0D
            | 0x20..=0x7E
            | 0xA0..=0xFF
            | 0x20AC
            | 0x201A
            | 0x0192
            | 0x201E
            | 0x2026
            | 0x2020
            | 0x2021
            | 0x02C6
            | 0x2030
            | 0x0160
            | 0x2039
            | 0x0152
            | 0x017D
            | 0x2018
            | 0x2019
            | 0x201C
            | 0x201D
            | 0x2022
            | 0x2013
            | 0x2014
            | 0x02DC
            | 0x2122
            | 0x0161
            | 0x203A
            | 0x0153
            | 0x017E
            | 0x0178
    )
}

/// Rejects text containing any character outside [`is_winansi_representable`] — see the module
/// doc comment. Called before *every* `set_text`/`create_text_object` call in this module,
/// regardless of whether the target font is standard or embedded: the crash this guards against
/// reproduces against a plain standard font, and no substitute this module could pick would
/// cover a script that every standard font's encoding also excludes.
pub(crate) fn ensure_winansi_encodable(text: &str) -> Result<(), RubricaError> {
    if text.chars().all(is_winansi_representable) {
        Ok(())
    } else {
        Err(RubricaError::invalid_arg(
            "text contains a character that no supported font can represent (only ASCII, \
             Latin accented characters, and standard punctuation are supported)",
        ))
    }
}

/// Every glyph shape PDFium's own encoding tables can represent depends on the specific font
/// resource, not just its base name — see the module doc comment's "Font reuse vs.
/// substitution" section. This heuristic only picks a *visually plausible* standard-font
/// stand-in once reuse has already behaviorally failed; it is never used to decide whether
/// reuse should be attempted in the first place.
pub(crate) fn guess_builtin(
    name: &str,
    weight: Option<PdfFontWeight>,
    italic: bool,
) -> PdfFontBuiltin {
    let lower = name.to_ascii_lowercase();
    let bold = matches!(
        weight,
        Some(PdfFontWeight::Weight700Bold)
            | Some(PdfFontWeight::Weight800)
            | Some(PdfFontWeight::Weight900)
    ) || lower.contains("bold");
    let italic = italic || lower.contains("italic") || lower.contains("oblique");

    if lower.contains("courier") || lower.contains("mono") {
        match (bold, italic) {
            (true, true) => PdfFontBuiltin::CourierBoldOblique,
            (true, false) => PdfFontBuiltin::CourierBold,
            (false, true) => PdfFontBuiltin::CourierOblique,
            (false, false) => PdfFontBuiltin::Courier,
        }
    } else if lower.contains("times")
        || lower.contains("serif")
        || lower.contains("georgia")
        || lower.contains("garamond")
    {
        match (bold, italic) {
            (true, true) => PdfFontBuiltin::TimesBoldItalic,
            (true, false) => PdfFontBuiltin::TimesBold,
            (false, true) => PdfFontBuiltin::TimesItalic,
            (false, false) => PdfFontBuiltin::TimesRoman,
        }
    } else {
        match (bold, italic) {
            (true, true) => PdfFontBuiltin::HelveticaBoldOblique,
            (true, false) => PdfFontBuiltin::HelveticaBold,
            (false, true) => PdfFontBuiltin::HelveticaOblique,
            (false, false) => PdfFontBuiltin::Helvetica,
        }
    }
}

/// A page object captured just before removal, holding everything needed to recreate an
/// equivalent replacement later via [`restore_removed`]. Deliberately **not** `Serialize` —
/// every field that holds it is `#[serde(skip)]`, which is sound because `revert()` is only
/// ever called within the same live process that called the matching `apply()` (journal replay
/// only ever calls `apply()` — see `API.md`'s "Autosave journal" section), so this can hold
/// arbitrary in-memory PDFium handles (a [`PdfFontToken`]) and decoded image data instead of
/// bytes that would need to round-trip through JSON.
///
/// Recreated objects are always *appended* to the page's object list, not reinserted at their
/// original index — a deliberate, documented scope cut: undo-after-redact restores content,
/// position, size, and (for text, via the captured font token) the exact original font, but not
/// necessarily the original paint order relative to objects that were never removed. This only
/// matters if something else visually overlapped the redacted/deleted object at the same spot,
/// which is not the common case.
#[derive(Debug)]
pub(crate) enum RemovedObject {
    Text {
        text: String,
        token: PdfFontToken,
        font_size: PdfPoints,
        rect: PdfRect,
        color: PdfColor,
    },
    Image {
        image: image::DynamicImage,
        rect: PdfRect,
    },
}

// Safety: every PDFium touch anywhere in this app is serialized behind `SessionStore`'s single
// Mutex (see `src-tauri/API.md`'s "engine::document" section) — this handle is never genuinely
// accessed from two threads at once, the same reasoning `pdfium-render` itself relies on for its
// own `unsafe impl Send for PdfDocument`/`PdfFont` under the `thread_safe` feature. Needed
// because `Command: Send` (a fixed supertrait bound in `engine::history`, not ours to change)
// and a raw `FPDF_FONT` handle inside `PdfFontToken` is not `Send` by default.
unsafe impl Send for RemovedObject {}

/// Captures enough of `obj` (a text or image object) to recreate an equivalent object later —
/// see [`RemovedObject`]. Called *before* the object is removed from its page.
pub(crate) fn capture_removable(obj: &PdfPageObject) -> Result<RemovedObject, RubricaError> {
    let rect = obj.bounds().map_err(pdfium_err)?.to_rect();
    let color = obj.fill_color().unwrap_or(PdfColor::new(0, 0, 0, 255));
    match obj.object_type() {
        PdfPageObjectType::Text => {
            let text_obj = obj
                .as_text_object()
                .ok_or_else(|| RubricaError::internal("expected a text object"))?;
            Ok(RemovedObject::Text {
                text: text_obj.text(),
                token: text_obj.font().token(),
                font_size: text_obj.unscaled_font_size(),
                rect,
                color,
            })
        }
        PdfPageObjectType::Image => {
            let image_obj = obj
                .as_image_object()
                .ok_or_else(|| RubricaError::internal("expected an image object"))?;
            Ok(RemovedObject::Image {
                image: image_obj.get_raw_image().map_err(pdfium_err)?,
                rect,
            })
        }
        _ => Err(RubricaError::invalid_arg(
            "object is not a text or image object",
        )),
    }
}

/// Removes the object at `index` *without* ever calling `FPDFPageObj_Destroy` on it. **Use this
/// everywhere in this module and in `engine::redact` — never call the underlying
/// `PdfPageObjectsCommon::remove_object`/`remove_object_at_index` and discard its `Ok` value
/// directly.**
///
/// A real, empirically-confirmed crash this works around: those two `pdfium-render` methods
/// hand back the now-detached object, and `PdfPageObject`'s `Drop` impl calls
/// `FPDFPageObj_Destroy` on any object that isn't currently owned by a page (confirmed by
/// reading the vendored source — see `pdf/document/page/object/private.rs`'s `drop_impl`).
/// Simply discarding that return value — the obvious way to write a plain removal, and exactly
/// what a bare `remove_object_at_index(i)?;` statement does — destroys the object immediately.
/// On this vendored chromium/8035 build that has been observed to crash the whole process
/// outright (`STATUS_ILLEGAL_INSTRUCTION`, no panic, `catch_unwind` can't help) in two distinct
/// ways: destroying a text object whose [`PdfFontToken`] is reused afterward (`restore_removed`
/// rebuilding a deleted/redacted run with its original font) invalidates that token; and,
/// separately, destroying a text object created via a document-level standard-font token
/// (`textobj_add`'s `doc.fonts_mut().new_built_in(..)`) crashes even with no token reuse
/// downstream at all — reproduced by undoing a plain `textobj_add` with nothing else going on.
/// Whatever the exact native-side cause, leaking the detached wrapper with `std::mem::forget`
/// avoids calling `FPDFPageObj_Destroy` on it entirely, sidestepping both. The small amount of
/// native memory this leaks per removal is reclaimed the moment the whole document closes
/// (`FPDF_CloseDocument` frees everything it owns regardless of individual object leaks), which
/// is a fully acceptable trade for not crashing.
pub(crate) fn remove_object_at_index_leaking(
    page: &mut PdfPage<'static>,
    index: usize,
) -> Result<(), RubricaError> {
    let detached = page
        .objects_mut()
        .remove_object_at_index(index)
        .map_err(pdfium_err)?;
    std::mem::forget(detached);
    Ok(())
}

/// Recreates an object captured by [`capture_removable`], appended to the end of `page`'s
/// object list. See [`RemovedObject`]'s doc comment for the paint-order caveat this accepts.
pub(crate) fn restore_removed(
    page: &mut PdfPage<'static>,
    item: RemovedObject,
) -> Result<(), RubricaError> {
    match item {
        RemovedObject::Text {
            text,
            token,
            font_size,
            rect,
            color,
        } => {
            let mut obj = page
                .objects_mut()
                .create_text_object(rect.left(), rect.bottom(), text, token, font_size)
                .map_err(pdfium_err)?;
            obj.set_fill_color(color).map_err(pdfium_err)?;
        }
        RemovedObject::Image { image, rect } => {
            page.objects_mut()
                .create_image_object(
                    rect.left(),
                    rect.bottom(),
                    &image,
                    Some(rect.width()),
                    Some(rect.height()),
                )
                .map_err(pdfium_err)?;
        }
    }
    Ok(())
}

/// `text_objects(docId, page)` — read-only, so this isn't a `Command`; it doesn't touch the
/// undo stack or the journal.
pub fn list_text_runs(session: &DocumentSession, page: u32) -> Result<Vec<TextRun>, RubricaError> {
    let pdf_page = get_page(session.document(), page)?;
    let mut runs = Vec::new();

    for (index, obj) in pdf_page.objects().iter().enumerate() {
        if obj.object_type() != PdfPageObjectType::Text {
            continue;
        }
        let Ok(bounds) = obj.bounds() else { continue };
        let Some(text_obj) = obj.as_text_object() else {
            continue;
        };
        let font = text_obj.font();
        let font_name = {
            let name = font.name();
            if name.is_empty() {
                font.family()
            } else {
                name
            }
        };

        runs.push(TextRun {
            object_id: format_object_id(page, index),
            rect: rect_to_dto(&bounds.to_rect()),
            text: text_obj.text(),
            font_name,
            font_size: text_obj.unscaled_font_size().value as f64,
            embedded_font_usable: font.is_embedded().unwrap_or(false),
        });
    }

    Ok(runs)
}

fn new_substituted_flag() -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

/// `textobj_set_text` — see the module doc comment for the reuse-vs-substitute decision. The
/// `Command` trait can only report invalidated pages through its fixed return type, so
/// `fontSubstituted` (needed by `SetTextResult`, CONTRACTS §3) is reported back to the caller
/// through a shared flag handed out by [`SetTextCommand::new`] instead — a plain, standard way
/// to get one extra piece of output from a boxed trait-object call without the frozen `Command`
/// trait (owned by R2, `engine::history`) needing a new method.
#[derive(Debug, Serialize, Deserialize)]
pub struct SetTextCommand {
    page: u32,
    index: usize,
    new_text: String,
    #[serde(skip, default = "new_substituted_flag")]
    substituted_flag: Arc<AtomicBool>,
    /// Whether `apply()` replaced the object (substitution) rather than editing it in place —
    /// decides how `revert()` undoes it. Harmless to journal (a plain `bool`, unlike the other
    /// skip fields), but never meaningfully read back after replay since replay never reverts.
    #[serde(default)]
    replaced: bool,
    #[serde(skip)]
    undo: Option<RemovedObject>,
}

impl SetTextCommand {
    /// Returns the command plus a flag that will hold the `fontSubstituted` outcome once
    /// `DocumentSession::commit` has run it.
    pub fn new(page: u32, index: usize, new_text: String) -> (Self, Arc<AtomicBool>) {
        let flag = new_substituted_flag();
        (
            Self {
                page,
                index,
                new_text,
                substituted_flag: flag.clone(),
                replaced: false,
                undo: None,
            },
            flag,
        )
    }
}

#[typetag::serde]
impl Command for SetTextCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        ensure_winansi_encodable(&self.new_text)?;
        let mut page = get_page(doc, self.page)?;

        let (original_text, token, font_size, rect, color, font_name, font_weight, font_italic) = {
            let obj = page.objects().get(self.index).map_err(|_| {
                RubricaError::invalid_arg(format!(
                    "no object at index {} on page {}",
                    self.index, self.page
                ))
            })?;
            let bounds = obj.bounds().map_err(pdfium_err)?.to_rect();
            let color = obj.fill_color().unwrap_or(PdfColor::new(0, 0, 0, 255));
            let text_obj = obj
                .as_text_object()
                .ok_or_else(|| RubricaError::invalid_arg("object is not a text run"))?;
            let font = text_obj.font();
            (
                text_obj.text(),
                font.token(),
                text_obj.unscaled_font_size(),
                bounds,
                color,
                font.name(),
                font.weight().ok(),
                font.is_italic(),
            )
        };

        let expected = if self.new_text.is_empty() {
            " ".to_string()
        } else {
            self.new_text.clone()
        };

        {
            let mut obj = page.objects().get(self.index).map_err(pdfium_err)?;
            let text_obj = obj
                .as_text_object_mut()
                .ok_or_else(|| RubricaError::invalid_arg("object is not a text run"))?;
            text_obj.set_text(&self.new_text).map_err(pdfium_err)?;
        }
        // See the module doc comment: set_text() alone does not regenerate content.
        page.regenerate_content().map_err(pdfium_err)?;

        let readback = page
            .objects()
            .get(self.index)
            .ok()
            .and_then(|obj| obj.as_text_object().map(|t| t.text()))
            .unwrap_or_default();
        let substituted = readback != expected;

        if substituted {
            remove_object_at_index_leaking(&mut page, self.index)?;

            let builtin = guess_builtin(&font_name, font_weight, font_italic);
            let substitute_token = doc.fonts_mut().new_built_in(builtin);
            let mut page2 = get_page(doc, self.page)?;
            let mut new_obj = page2
                .objects_mut()
                .create_text_object(
                    rect.left(),
                    rect.bottom(),
                    self.new_text.clone(),
                    substitute_token,
                    font_size,
                )
                .map_err(pdfium_err)?;
            new_obj.set_fill_color(color).map_err(pdfium_err)?;
        }

        self.replaced = substituted;
        self.undo = Some(RemovedObject::Text {
            text: original_text,
            token,
            font_size,
            rect,
            color,
        });
        self.substituted_flag.store(substituted, Ordering::Relaxed);
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut page = get_page(doc, self.page)?;
        let undo = self
            .undo
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;

        if self.replaced {
            // apply() removed the original and appended a substitute-font replacement; undo
            // removes that replacement (the last object it added) and recreates the original
            // using its own captured font token — see RemovedObject's paint-order caveat.
            let len = page.objects().len();
            if len > 0 {
                remove_object_at_index_leaking(&mut page, len - 1)?;
            }
            restore_removed(&mut page, undo)?;
        } else if let RemovedObject::Text { text, .. } = &undo {
            {
                let mut obj = page.objects().get(self.index).map_err(pdfium_err)?;
                let text_obj = obj
                    .as_text_object_mut()
                    .ok_or_else(|| RubricaError::internal("object is no longer a text run"))?;
                text_obj.set_text(text).map_err(pdfium_err)?;
            }
            page.regenerate_content().map_err(pdfium_err)?;
        }

        self.substituted_flag.store(false, Ordering::Relaxed);
        Ok(vec![self.page])
    }
}

/// `textobj_add` — always a standard font (Helvetica), per the brief.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddTextObjectCommand {
    page: u32,
    spec: TextObjectSpec,
    #[serde(skip)]
    inserted_at: Option<usize>,
}

impl AddTextObjectCommand {
    pub fn new(page: u32, spec: TextObjectSpec) -> Self {
        Self {
            page,
            spec,
            inserted_at: None,
        }
    }
}

#[typetag::serde]
impl Command for AddTextObjectCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        ensure_winansi_encodable(&self.spec.text)?;
        let token = doc.fonts_mut().new_built_in(PdfFontBuiltin::Helvetica);
        let mut page = get_page(doc, self.page)?;
        let index = page.objects().len();
        let mut obj = page
            .objects_mut()
            .create_text_object(
                PdfPoints::new(self.spec.rect.x as f32),
                PdfPoints::new(self.spec.rect.y as f32),
                self.spec.text.clone(),
                token,
                PdfPoints::new(self.spec.font_size as f32),
            )
            .map_err(pdfium_err)?;
        obj.set_fill_color(color_from_hex(&self.spec.color)?)
            .map_err(pdfium_err)?;
        self.inserted_at = Some(index);
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let index = self
            .inserted_at
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        let mut page = get_page(doc, self.page)?;
        remove_object_at_index_leaking(&mut page, index)?;
        Ok(vec![self.page])
    }
}

/// `imageobj_add` — loads the image from `spec.path` (PNG or JPEG) and scales it to `spec.rect`.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddImageObjectCommand {
    page: u32,
    spec: ImageObjectSpec,
    #[serde(skip)]
    inserted_at: Option<usize>,
}

impl AddImageObjectCommand {
    pub fn new(page: u32, spec: ImageObjectSpec) -> Self {
        Self {
            page,
            spec,
            inserted_at: None,
        }
    }
}

#[typetag::serde]
impl Command for AddImageObjectCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let dynamic_image = image::open(&self.spec.path)
            .map_err(|e| RubricaError::io(format!("could not read \"{}\": {e}", self.spec.path)))?;
        let mut page = get_page(doc, self.page)?;
        let index = page.objects().len();
        page.objects_mut()
            .create_image_object(
                PdfPoints::new(self.spec.rect.x as f32),
                PdfPoints::new(self.spec.rect.y as f32),
                &dynamic_image,
                Some(PdfPoints::new(self.spec.rect.width as f32)),
                Some(PdfPoints::new(self.spec.rect.height as f32)),
            )
            .map_err(pdfium_err)?;
        self.inserted_at = Some(index);
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let index = self
            .inserted_at
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        let mut page = get_page(doc, self.page)?;
        remove_object_at_index_leaking(&mut page, index)?;
        Ok(vec![self.page])
    }
}

/// `object_delete` — supports the text/image object types this tool (and `redact`) own. See
/// [`capture_removable`]/[`restore_removed`] for the undo mechanics.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteObjectCommand {
    page: u32,
    index: usize,
    #[serde(skip)]
    undo: Option<RemovedObject>,
}

impl DeleteObjectCommand {
    pub fn new(page: u32, index: usize) -> Self {
        Self {
            page,
            index,
            undo: None,
        }
    }
}

#[typetag::serde]
impl Command for DeleteObjectCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut page = get_page(doc, self.page)?;
        let snapshot = {
            let obj = page.objects().get(self.index).map_err(|_| {
                RubricaError::invalid_arg(format!(
                    "no object at index {} on page {}",
                    self.index, self.page
                ))
            })?;
            capture_removable(&obj)?
        };
        remove_object_at_index_leaking(&mut page, self.index)?;
        self.undo = Some(snapshot);
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut page = get_page(doc, self.page)?;
        let snapshot = self
            .undo
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        restore_removed(&mut page, snapshot)?;
        Ok(vec![self.page])
    }
}

/// Pure-function tests — no PDFium document involved, so (unlike `tests/engine_fixtures.rs`)
/// these are ordinary `#[test]`s, safe to run on libtest's usual one-thread-per-test model.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn winansi_repertoire_covers_ascii_and_pt_accents_but_not_cjk() {
        assert!(is_winansi_representable('A'));
        assert!(is_winansi_representable('9'));
        assert!(is_winansi_representable(' '));
        for c in "áàâãçéêíóôõúÁÀÂÃÇÉÊÍÓÔÕÚ".chars() {
            assert!(
                is_winansi_representable(c),
                "PT accent {c:?} should be WinAnsi-representable"
            );
        }
        // The smart-punctuation block unicode.pdf's fixture generator relies on.
        for c in ['\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2014}'] {
            assert!(
                is_winansi_representable(c),
                "{c:?} should be in WinAnsi's punctuation block"
            );
        }
        assert!(!is_winansi_representable('測'));
        assert!(!is_winansi_representable('🎉'));

        assert!(ensure_winansi_encodable("A normal ASCII sentence.").is_ok());
        assert!(ensure_winansi_encodable("Coração, ação, informação.").is_ok());
        assert!(ensure_winansi_encodable("測試").is_err());
    }

    /// The "glyph-coverage/substitution matrix" this deliverable calls for: which builtin font
    /// a substitution rebuilds with, for a representative spread of original font
    /// names/weights/italic angles. `guess_builtin` is a pure function precisely so this
    /// doesn't need a live PDFium document to exercise.
    #[test]
    fn guess_builtin_matches_family_weight_and_italic() {
        assert_eq!(
            guess_builtin("Helvetica", None, false),
            PdfFontBuiltin::Helvetica
        );
        assert_eq!(
            guess_builtin("Helvetica-Bold", Some(PdfFontWeight::Weight700Bold), false),
            PdfFontBuiltin::HelveticaBold
        );
        assert_eq!(
            guess_builtin("Helvetica-Oblique", None, true),
            PdfFontBuiltin::HelveticaOblique
        );
        assert_eq!(
            guess_builtin(
                "Helvetica-BoldOblique",
                Some(PdfFontWeight::Weight700Bold),
                true
            ),
            PdfFontBuiltin::HelveticaBoldOblique
        );
        assert_eq!(
            guess_builtin("TimesNewRomanPSMT", None, false),
            PdfFontBuiltin::TimesRoman
        );
        assert_eq!(
            guess_builtin("Times-BoldItalic", Some(PdfFontWeight::Weight700Bold), true),
            PdfFontBuiltin::TimesBoldItalic
        );
        assert_eq!(
            guess_builtin("CourierNewPSMT", None, false),
            PdfFontBuiltin::Courier
        );
        assert_eq!(
            guess_builtin("Courier-Bold", Some(PdfFontWeight::Weight700Bold), false),
            PdfFontBuiltin::CourierBold
        );
        // An unrecognized family name falls back to Helvetica rather than erroring.
        assert_eq!(
            guess_builtin("SomeObscureEmbeddedFont", None, false),
            PdfFontBuiltin::Helvetica
        );
    }
}
