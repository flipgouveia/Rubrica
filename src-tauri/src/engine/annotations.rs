//! Standard PDF annotation objects (highlight/underline/strikeout/ink/note/
//! shape/freeText) — R5's module. Backs `commands::annotations` with real
//! PDFium calls; see `src-tauri/API.md` for the session-level API this
//! builds on and this module's own doc comments below for the mapping
//! decisions (and their compromises) made against pdfium-render 0.9.3's
//! real, verified limits.
//!
//! ## Coordinate convention
//!
//! Same as the rest of the engine (`API.md`): every `Rect`/`QuadPoint`/
//! `Point` here is PDF points, origin bottom-left — PDFium's native space,
//! no flipping.
//!
//! ## Annotation identity (`AnnotId`)
//!
//! PDFium has no persistent per-annotation identifier reachable via the
//! public API (`/NM` only has a getter, no setter). [`make_annot_id`] uses
//! `format!("p{page}a{index}")` — the CURRENT page index and CURRENT
//! within-page annotation-array index at the time [`list_annots`] produced
//! it. This id is only guaranteed valid within one open session between
//! successive `annot_list` calls: it goes stale if another annotation on the
//! same page is added/removed, or a pages-domain structural op reindexes the
//! page, between when the UI fetched it and when it's used. This is a known,
//! accepted, documented limitation — [`parse_annot_id`]'s callers
//! (`commands::annotations`) bounds-check the parsed `(page, index)` against
//! the live document and return `NOT_FOUND` rather than silently touching the
//! wrong annotation, but they cannot detect "index N still exists, but it's
//! now a *different* annotation than the one the caller meant". A future
//! wave that needs a persistent id would have to add new session-level
//! state, which is out of scope for a wave-2 module (CONTRACTS §6).
//!
//! ## The stamp-annotation compromise (Ellipse/Line/Arrow shapes)
//!
//! pdfium-render 0.9.3's public, ergonomic annotation constructors
//! (`PdfPageAnnotations::create_*`) cover FreeText, Highlight, Ink, Link,
//! Popup, Square, Squiggly, Stamp, Strikeout, Text, Underline — there is no
//! `create_circle_annotation`/`create_line_annotation`, and no raw-FFI escape
//! hatch (every handle-returning method is `pub(crate)`-gated). Only Ink and
//! Stamp annotations expose a mutable page-objects collection
//! (`objects_mut()`) to draw custom content into.
//!
//! So `shape:ellipse`/`shape:line`/`shape:arrow` are stored as a **Stamp**
//! annotation (`/Subtype /Stamp`) whose own drawn content (via
//! `objects_mut()`) is a real path object shaped like the requested
//! geometry — a correctly stroked/filled ellipse, or a line (plus a small
//! filled triangle for the arrowhead). This is fully standard, portable PDF:
//! a Stamp annotation with a real, correctly drawn appearance is rendered
//! correctly by any conforming reader (Acrobat, browsers, phones) — visually
//! and functionally identical to what a native Circle/Line annotation would
//! show. The **only** compromise is metadata fidelity: a PDF inspector (or
//! another tool that cares about `/Subtype`) sees "Stamp", not "Circle" /
//! "Line". Since a Stamp annotation could legitimately come from a foreign,
//! non-Rubrica PDF too, [`shape_marker`] writes a short, unambiguous marker
//! into the annotation's `/Contents` (using U+2063 INVISIBLE SEPARATOR as a
//! delimiter, not NUL — NUL risks truncation in some UTF-16LE / C-string-ish
//! code paths, U+2063 does not) identifying it as Rubrica's and which shape
//! kind; [`list_annots`] skips a Stamp annotation that doesn't carry this
//! marker (foreign stamp, not ours) rather than erroring or misreporting it.
//! A natively-created `Circle` annotation from a foreign PDF (pdfium-render
//! CAN *read*, just not *create*, one) is read back as `shape:ellipse` too,
//! for better fidelity on files Rubrica didn't create.
//!
//! `shape:rect` uses a real `Square` annotation (`/Subtype /Square`) — no
//! compromise needed there, since Square is in the public constructor list.
//!
//! ## The FreeText font-size/color compromise
//!
//! Checked exhaustively against the vendored source
//! (`pdf/document/page/annotation/variable_text.rs`): `font_size` has ONLY a
//! getter in pdfium-render 0.9.3 (no setter exists in *any* version of the
//! crate — this isn't a feature-flag gap, the method is simply absent).
//! `font_color`/`set_font_color` exist but are gated behind
//! `pdfium_future`/`pdfium_7881`/`pdfium_7763`/`pdfium_7350`-family Cargo
//! features that `Cargo.toml` does not enable (and is not permitted to
//! change for this wave without a report — see the wave report). The generic
//! `PdfPageAnnotationCommon::stroke_color`/`fill_color` setters exist, but
//! per the PDF spec (and pdfium's own appearance-stream generation for
//! FreeText) they control the annotation's *border*/*background*, not the
//! text glyph color, which is driven by the `/DA` string — and there is no
//! public way to write an arbitrary `/DA` string either (the
//! `set_string_value` that could write it is `pub(crate)`-gated inside
//! `annotation::private::internal`, unreachable from this crate).
//!
//! So `FreeText.rect` and `.text` are fully honored (real bounds, real
//! `/Contents`). `.font_size`/`.color` are accepted on `annot_add` but not
//! persisted anywhere PDFium exposes back to us; `annot_list` reports fixed
//! defaults ([`DEFAULT_FREE_TEXT_FONT_SIZE`]/[`DEFAULT_FREE_TEXT_COLOR`]) for
//! them rather than fabricating a value that isn't actually backed by the
//! document. This is a real, documented fidelity gap — not a bug — see the
//! wave report for confirmation this was checked against the actual crate
//! source, not assumed.
//!
//! ## The Square border-width and fill-opacity compromises
//!
//! `Square`'s border width (`/BS /W`) has no public getter/setter either
//! (only a path *object's* `stroke_width` does, which Square doesn't use —
//! it's driven by pdfium's own generated appearance, not our own path
//! objects). So `shape:rect`'s `stroke.width` is accepted on write but not
//! persisted/read back (`None` on `annot_list`). Separately,
//! `FPDFAnnot_SetColor` (confirmed against pdfium's real behavior: setting
//! the `Color` color-type ALSO sets the annotation's `/CA` — constant/whole-
//! annotation opacity — from the alpha channel; setting `InteriorColor`
//! (`/IC`) does not) means `stroke.opacity` round-trips via `/CA`, but
//! `fill.opacity` has nowhere to go — it is accepted but not persisted
//! (`fill.opacity` always reads back as `1.0`). Ellipse/Line/Arrow (the
//! Stamp-based shapes) do NOT have this limitation: their stroke/fill live on
//! a real path *object*, which has its own genuine `stroke_width`/alpha —
//! full round-trip there.
//!
//! ## Two crashes found empirically, and how this module avoids them
//!
//! Both were found by actually running this code against the vendored
//! PDFium binary (not from reading pdfium-render's docs, which say nothing
//! about either) — see the wave report for the full writeup.
//!
//! 1. **Mutating a `PdfPagePathObject` after it has already been attached**
//!    (via `add_path_object`/`create_path_object_line`/etc.) reliably
//!    segfaults. [`add_ink_stroke`] therefore builds one *detached* path
//!    object for a whole stroke (one `move_to` + N `line_to` calls) and
//!    attaches it to the annotation's objects collection only once, as the
//!    very last step.
//! 2. **Calling `PdfPageAnnotationCommon::set_stroke_color`/`set_fill_color`
//!    on an Ink annotation that already has content objects** reliably
//!    segfaults too: `FPDFAnnot_SetColor` returns failure for an annotation
//!    using appearance streams, and pdfium-render's own fallback path
//!    (`set_stroke_color_impl`) then calls `FPDFPageObj_SetStrokeColor`
//!    with the *annotation's* handle reinterpreted as if it were a
//!    page-*object* handle — a real type confusion in that fallback. So
//!    Ink's top-level `opacity` is baked into each stroke's own alpha
//!    channel instead of the annotation's `/CA` (unlike
//!    Highlight/Underline/Strikeout/Square, which never touch
//!    `objects_mut()` and so never hit this fallback — `set_stroke_color`
//!    is safe and used normally on those).
//!
//! A related but distinct finding: **removing an existing object from a
//! *live*, non-empty Ink/Stamp annotation** via
//! `PdfPageObjectsCommon::remove_object_at_index` also reliably segfaults —
//! even though the exact same removal on an annotation that was *just*
//! created (still empty, so the loop never actually removes anything) is
//! fine, and even though deleting the *whole* annotation via
//! `PdfPageAnnotations::delete_annotation` is *also* fine. Because of this,
//! [`UpdateAnnotCommand`] never rewrites an Ink/Stamp-shape annotation's
//! drawn geometry in place — see [`spec_draws_own_objects`]'s doc comment
//! for how it instead deletes the annotation and creates a fresh one.
use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::history::Command;
use crate::types::{
    Annot, AnnotId, AnnotPatch, AnnotSpec, Point, QuadPoint, Rect, RubricaError, ShapeKind, Stroke,
    StrokeFill,
};

/// Fixed icon footprint for `note` annotations (PDF points) — matches
/// `src/tools/annotate/geometry.ts`'s `NOTE_ICON_SIZE_PT` exactly; notes are
/// movable but not resizable.
const NOTE_ICON_SIZE_PT: f64 = 24.0;

/// See the module doc comment's "FreeText font-size/color compromise".
const DEFAULT_FREE_TEXT_FONT_SIZE: f64 = 12.0;
const DEFAULT_FREE_TEXT_COLOR: &str = "#000000";

/// See the module doc comment's "stamp-annotation compromise". U+2063
/// (INVISIBLE SEPARATOR) is used as the delimiter rather than NUL, which
/// risks truncation in some UTF-16LE/C-string-ish code paths.
const SHAPE_MARKER_PREFIX: &str = "\u{2063}rubrica-shape:";
const SHAPE_MARKER_SUFFIX: &str = "\u{2063}";

// --- annotation id scheme ----------------------------------------------------

/// See the module doc comment's "Annotation identity" section.
pub fn make_annot_id(page: u32, index: usize) -> AnnotId {
    format!("p{page}a{index}")
}

/// Inverse of [`make_annot_id`]. Returns `None` if `id` isn't in the
/// expected shape; callers should treat that the same as "not found" — it
/// can never refer to a live annotation.
pub fn parse_annot_id(id: &str) -> Option<(u32, usize)> {
    let rest = id.strip_prefix('p')?;
    let (page_str, index_str) = rest.split_once('a')?;
    let page: u32 = page_str.parse().ok()?;
    let index: usize = index_str.parse().ok()?;
    Some((page, index))
}

/// The page every `AnnotSpec` variant carries — used both for `annot_add`'s
/// range check and internally by [`AddAnnotCommand`].
pub fn spec_page(spec: &AnnotSpec) -> u32 {
    match spec {
        AnnotSpec::Highlight { page, .. }
        | AnnotSpec::Underline { page, .. }
        | AnnotSpec::Strikeout { page, .. }
        | AnnotSpec::Ink { page, .. }
        | AnnotSpec::Note { page, .. }
        | AnnotSpec::Shape { page, .. }
        | AnnotSpec::FreeText { page, .. } => *page,
    }
}

// --- small conversions --------------------------------------------------------

fn pdfium_err(e: PdfiumError) -> RubricaError {
    RubricaError::internal(e.to_string())
}

fn opacity_to_alpha(opacity: f64) -> u8 {
    (opacity.clamp(0.0, 1.0) * 255.0).round() as u8
}

fn alpha_to_opacity(alpha: u8) -> f64 {
    alpha as f64 / 255.0
}

/// Parses a `#rrggbb` string plus a separate 0..1 opacity into a
/// [`PdfColor`] with the matching alpha channel.
fn parse_color(hex: &str, opacity: f64) -> Result<PdfColor, RubricaError> {
    let color = PdfColor::from_hex(hex)
        .map_err(|e| RubricaError::invalid_arg(format!("invalid color \"{hex}\": {e}")))?;
    Ok(color.with_alpha(opacity_to_alpha(opacity)))
}

fn color_to_hex(color: PdfColor) -> String {
    format!("#{}", color.to_hex().to_lowercase())
}

fn rect_to_pdf(rect: &Rect) -> PdfRect {
    let x = rect.x as f32;
    let y = rect.y as f32;
    let w = rect.width as f32;
    let h = rect.height as f32;
    PdfRect::new(
        PdfPoints::new(y),
        PdfPoints::new(x),
        PdfPoints::new(y + h),
        PdfPoints::new(x + w),
    )
}

fn pdf_to_rect(rect: PdfRect) -> Rect {
    Rect {
        x: rect.left().value as f64,
        y: rect.bottom().value as f64,
        width: rect.width().value as f64,
        height: rect.height().value as f64,
    }
}

fn quad_to_pdf(q: &QuadPoint) -> PdfQuadPoints {
    PdfQuadPoints::new_from_values(
        q.x1 as f32,
        q.y1 as f32,
        q.x2 as f32,
        q.y2 as f32,
        q.x3 as f32,
        q.y3 as f32,
        q.x4 as f32,
        q.y4 as f32,
    )
}

fn pdf_to_quad(q: PdfQuadPoints) -> QuadPoint {
    QuadPoint {
        x1: q.x1().value as f64,
        y1: q.y1().value as f64,
        x2: q.x2().value as f64,
        y2: q.y2().value as f64,
        x3: q.x3().value as f64,
        y3: q.y3().value as f64,
        x4: q.x4().value as f64,
        y4: q.y4().value as f64,
    }
}

fn shape_marker(shape: ShapeKind) -> String {
    let name = match shape {
        ShapeKind::Ellipse => "ellipse",
        ShapeKind::Line => "line",
        ShapeKind::Arrow => "arrow",
        // Rect never actually reaches this function (it uses a Square
        // annotation, not Stamp) — kept exhaustive rather than `_`.
        ShapeKind::Rect => "rect",
    };
    format!("{SHAPE_MARKER_PREFIX}{name}{SHAPE_MARKER_SUFFIX}")
}

fn parse_shape_marker(contents: &str) -> Option<ShapeKind> {
    let rest = contents.strip_prefix(SHAPE_MARKER_PREFIX)?;
    let name = rest.strip_suffix(SHAPE_MARKER_SUFFIX)?;
    match name {
        "ellipse" => Some(ShapeKind::Ellipse),
        "line" => Some(ShapeKind::Line),
        "arrow" => Some(ShapeKind::Arrow),
        _ => None,
    }
}

fn kind_mismatch() -> RubricaError {
    RubricaError::internal("annotation kind mismatch during write-back (unexpected engine state)")
}

// --- bbox-transform semantics -------------------------------------------------
// Faithful port of `src/tools/annotate/geometry.ts`'s `getAnnotBBox`/
// `applyBBoxToAnnot` — see CONTRACTS-adjacent brief for why `AnnotPatch.rect`
// means "new bounding box", not literally a `rect` field, for every kind.

fn bbox_from_points(xs: &[f64], ys: &[f64]) -> Rect {
    if xs.is_empty() {
        return Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        };
    }
    let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
    let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    Rect {
        x: min_x,
        y: min_y,
        width: max_x - min_x,
        height: max_y - min_y,
    }
}

fn bbox_of_quadpoints(quadpoints: &[QuadPoint]) -> Rect {
    let mut xs = Vec::with_capacity(quadpoints.len() * 4);
    let mut ys = Vec::with_capacity(quadpoints.len() * 4);
    for q in quadpoints {
        xs.extend_from_slice(&[q.x1, q.x2, q.x3, q.x4]);
        ys.extend_from_slice(&[q.y1, q.y2, q.y3, q.y4]);
    }
    bbox_from_points(&xs, &ys)
}

fn bbox_of_strokes(strokes: &[Stroke]) -> Rect {
    let mut xs = Vec::new();
    let mut ys = Vec::new();
    for s in strokes {
        for p in &s.points {
            xs.push(p.x);
            ys.push(p.y);
        }
    }
    bbox_from_points(&xs, &ys)
}

fn get_bbox(spec: &AnnotSpec) -> Rect {
    match spec {
        AnnotSpec::Highlight { quadpoints, .. }
        | AnnotSpec::Underline { quadpoints, .. }
        | AnnotSpec::Strikeout { quadpoints, .. } => bbox_of_quadpoints(quadpoints),
        AnnotSpec::Ink { strokes, .. } => bbox_of_strokes(strokes),
        AnnotSpec::Note { point, .. } => Rect {
            x: point.x,
            y: point.y - NOTE_ICON_SIZE_PT,
            width: NOTE_ICON_SIZE_PT,
            height: NOTE_ICON_SIZE_PT,
        },
        AnnotSpec::Shape { rect, .. } | AnnotSpec::FreeText { rect, .. } => rect.clone(),
    }
}

/// Maps `old`'s geometry from its current bounding box onto `new_rect` via a
/// uniform per-axis translate+scale, mutating `new` (already a clone of
/// `old`) in place. Mirrors `applyBBoxToAnnot` exactly, including the
/// degenerate-zero-size-axis fallback to scale 1.
fn apply_bbox(new: &mut AnnotSpec, old: &AnnotSpec, new_rect: &Rect) {
    let old_bbox = get_bbox(old);
    let old_w = old_bbox.width;
    let old_h = old_bbox.height;
    let new_w = if new_rect.width != 0.0 {
        new_rect.width
    } else {
        old_w
    };
    let new_h = if new_rect.height != 0.0 {
        new_rect.height
    } else {
        old_h
    };
    let scale_x = if old_w > 1e-6 { new_w / old_w } else { 1.0 };
    let scale_y = if old_h > 1e-6 { new_h / old_h } else { 1.0 };
    let origin_x = new_rect.x;
    let origin_y = new_rect.y;
    let map_x = |x: f64| origin_x + (x - old_bbox.x) * scale_x;
    let map_y = |y: f64| origin_y + (y - old_bbox.y) * scale_y;

    match new {
        AnnotSpec::Highlight { quadpoints, .. }
        | AnnotSpec::Underline { quadpoints, .. }
        | AnnotSpec::Strikeout { quadpoints, .. } => {
            for q in quadpoints.iter_mut() {
                q.x1 = map_x(q.x1);
                q.y1 = map_y(q.y1);
                q.x2 = map_x(q.x2);
                q.y2 = map_y(q.y2);
                q.x3 = map_x(q.x3);
                q.y3 = map_y(q.y3);
                q.x4 = map_x(q.x4);
                q.y4 = map_y(q.y4);
            }
        }
        AnnotSpec::Ink { strokes, .. } => {
            for s in strokes.iter_mut() {
                for p in s.points.iter_mut() {
                    p.x = map_x(p.x);
                    p.y = map_y(p.y);
                }
            }
        }
        AnnotSpec::Note { point, .. } => {
            point.x = origin_x;
            point.y = origin_y + NOTE_ICON_SIZE_PT;
        }
        AnnotSpec::Shape { rect, .. } | AnnotSpec::FreeText { rect, .. } => {
            *rect = new_rect.clone();
        }
    }
}

/// Pure function computing the new [`AnnotSpec`] a patch produces, mirroring
/// `mock/annotations.ts`'s `applyAnnotPatch` exactly: `color`/`opacity`/
/// `contents` are silently ignored on variants that don't structurally carry
/// that field (e.g. `color` on a `shape`), and `rect` is interpreted
/// generically as "new bounding box" via [`apply_bbox`].
fn apply_patch(old: &AnnotSpec, patch: &AnnotPatch) -> AnnotSpec {
    let mut new = old.clone();
    match &mut new {
        AnnotSpec::Highlight { color, opacity, .. }
        | AnnotSpec::Underline { color, opacity, .. }
        | AnnotSpec::Strikeout { color, opacity, .. } => {
            if let Some(c) = &patch.color {
                *color = c.clone();
            }
            if let Some(o) = patch.opacity {
                *opacity = o;
            }
        }
        AnnotSpec::Ink { opacity, .. } => {
            if let Some(o) = patch.opacity {
                *opacity = o;
            }
        }
        AnnotSpec::Note { contents, .. } => {
            if let Some(c) = &patch.contents {
                *contents = c.clone();
            }
        }
        AnnotSpec::Shape { .. } => {
            // Shape has neither a top-level `color`, `opacity`, nor
            // `contents` field (they live nested in `stroke`/`fill`) — no-op,
            // matching the mock's `"color" in mutable` guard.
        }
        AnnotSpec::FreeText { color, .. } => {
            if let Some(c) = &patch.color {
                *color = c.clone();
            }
        }
    }
    if let Some(new_rect) = &patch.rect {
        apply_bbox(&mut new, old, new_rect);
    }
    new
}

// --- page/annotation lookup helpers -------------------------------------------

fn get_page(doc: &PdfDocument<'static>, page: u32) -> Result<PdfPage<'static>, RubricaError> {
    if page >= doc.pages().len() as u32 {
        return Err(RubricaError::not_found(format!(
            "no page {page} in this document"
        )));
    }
    doc.pages().get(page as PdfPageIndex).map_err(pdfium_err)
}

fn check_index(page: &PdfPage<'static>, index: usize) -> Result<(), RubricaError> {
    if index >= page.annotations().len() {
        return Err(RubricaError::not_found(format!(
            "no annotation at index {index}"
        )));
    }
    Ok(())
}

// --- reading annotations (annot_list) -----------------------------------------

/// CONTRACTS §3's `annot_list` body. Read-only — no PDFium mutation, no
/// commit needed. An out-of-range `page_no` returns an empty list rather
/// than an error, matching `mock/annotations.ts::annotList`'s behavior of
/// simply filtering by page equality without validating the page argument.
pub fn list_annots(doc: &PdfDocument<'static>, page_no: u32) -> Result<Vec<Annot>, RubricaError> {
    if page_no >= doc.pages().len() as u32 {
        return Ok(Vec::new());
    }
    let page = doc
        .pages()
        .get(page_no as PdfPageIndex)
        .map_err(pdfium_err)?;
    let annotations = page.annotations();
    let mut result = Vec::with_capacity(annotations.len());
    for (index, annotation) in annotations.iter().enumerate() {
        if let Some(spec) = read_spec(&annotation, page_no)? {
            result.push(Annot {
                annot_id: make_annot_id(page_no, index),
                page: page_no,
                spec,
            });
        }
    }
    Ok(result)
}

fn read_quadpoints(annotation: &PdfPageAnnotation<'_>) -> Vec<QuadPoint> {
    annotation
        .attachment_points()
        .iter()
        .map(pdf_to_quad)
        .collect()
}

fn read_ink_strokes(annotation: &PdfPageAnnotation<'_>) -> Vec<Stroke> {
    let mut strokes = Vec::new();
    for obj in annotation.objects().iter() {
        if let Some(path) = obj.as_path_object() {
            let points: Vec<Point> = path
                .segments()
                .iter()
                .map(|seg| {
                    let (x, y) = seg.point();
                    Point {
                        x: x.value as f64,
                        y: y.value as f64,
                    }
                })
                .collect();
            let color = path
                .stroke_color()
                .map(color_to_hex)
                .unwrap_or_else(|_| "#000000".to_string());
            let width = path.stroke_width().map(|w| w.value as f64).unwrap_or(1.0);
            strokes.push(Stroke {
                points,
                width,
                color,
            });
        }
    }
    strokes
}

/// Ink's top-level `opacity` is baked into each stroke path object's own
/// alpha channel at write time (see [`add_ink_stroke`]'s doc comment for
/// why `annotation.set_stroke_color()` — which would otherwise piggyback on
/// `/CA` the way Highlight/Underline/Strikeout/Square do — is NOT safe to
/// call on Ink). Reads it back from the first stroke object's alpha,
/// defaulting to fully opaque if there are no stroke objects at all.
fn read_annotation_opacity(annotation: &PdfPageAnnotation<'_>) -> f64 {
    match annotation.objects().get(0) {
        Ok(obj) => obj
            .stroke_color()
            .map(|c| alpha_to_opacity(c.alpha()))
            .unwrap_or(1.0),
        Err(_) => 1.0,
    }
}

fn read_stroke_fill_common(annotation: &PdfPageAnnotation<'_>) -> (StrokeFill, StrokeFill) {
    let stroke = match annotation.stroke_color() {
        Ok(c) => StrokeFill {
            color: Some(color_to_hex(c)),
            opacity: alpha_to_opacity(c.alpha()),
            width: None, // Square's /BS border width has no public getter.
        },
        Err(_) => StrokeFill {
            color: None,
            opacity: 1.0,
            width: None,
        },
    };
    let fill = match annotation.fill_color() {
        Ok(c) => StrokeFill {
            color: Some(color_to_hex(c)),
            opacity: 1.0, // /IC carries no alpha in pdfium's SetColor — see module doc comment.
            width: None,
        },
        Err(_) => StrokeFill {
            color: None,
            opacity: 1.0,
            width: None,
        },
    };
    (stroke, fill)
}

fn read_stroke_fill_from_objects(annotation: &PdfPageAnnotation<'_>) -> (StrokeFill, StrokeFill) {
    match annotation.objects().get(0) {
        Ok(obj) => {
            let stroke = match obj.stroke_color() {
                Ok(c) => StrokeFill {
                    color: Some(color_to_hex(c)),
                    opacity: alpha_to_opacity(c.alpha()),
                    width: obj.stroke_width().ok().map(|w| w.value as f64),
                },
                Err(_) => StrokeFill {
                    color: None,
                    opacity: 1.0,
                    width: None,
                },
            };
            let fill = match obj.fill_color() {
                Ok(c) => StrokeFill {
                    color: Some(color_to_hex(c)),
                    opacity: alpha_to_opacity(c.alpha()),
                    width: None,
                },
                Err(_) => StrokeFill {
                    color: None,
                    opacity: 1.0,
                    width: None,
                },
            };
            (stroke, fill)
        }
        Err(_) => (
            StrokeFill {
                color: None,
                opacity: 1.0,
                width: None,
            },
            StrokeFill {
                color: None,
                opacity: 1.0,
                width: None,
            },
        ),
    }
}

/// Reconstructs an [`AnnotSpec`] from a live PDFium annotation, or `None` if
/// this annotation isn't a kind Rubrica owns/recognizes (a foreign Stamp
/// without our marker, a Link/Popup/Widget/etc.) — callers skip rather than
/// error on `None`, matching the brief.
fn read_spec(
    annotation: &PdfPageAnnotation<'_>,
    page_no: u32,
) -> Result<Option<AnnotSpec>, RubricaError> {
    match annotation.annotation_type() {
        PdfPageAnnotationType::Highlight => {
            let (stroke, _) = read_stroke_fill_common(annotation);
            Ok(Some(AnnotSpec::Highlight {
                page: page_no,
                quadpoints: read_quadpoints(annotation),
                color: stroke.color.unwrap_or_else(|| "#000000".to_string()),
                opacity: stroke.opacity,
            }))
        }
        PdfPageAnnotationType::Underline => {
            let (stroke, _) = read_stroke_fill_common(annotation);
            Ok(Some(AnnotSpec::Underline {
                page: page_no,
                quadpoints: read_quadpoints(annotation),
                color: stroke.color.unwrap_or_else(|| "#000000".to_string()),
                opacity: stroke.opacity,
            }))
        }
        PdfPageAnnotationType::Strikeout => {
            let (stroke, _) = read_stroke_fill_common(annotation);
            Ok(Some(AnnotSpec::Strikeout {
                page: page_no,
                quadpoints: read_quadpoints(annotation),
                color: stroke.color.unwrap_or_else(|| "#000000".to_string()),
                opacity: stroke.opacity,
            }))
        }
        PdfPageAnnotationType::Ink => Ok(Some(AnnotSpec::Ink {
            page: page_no,
            strokes: read_ink_strokes(annotation),
            opacity: read_annotation_opacity(annotation),
        })),
        PdfPageAnnotationType::Text => {
            let bounds = annotation.bounds().map_err(pdfium_err)?;
            let point = Point {
                x: bounds.left().value as f64,
                y: bounds.bottom().value as f64 + NOTE_ICON_SIZE_PT,
            };
            Ok(Some(AnnotSpec::Note {
                page: page_no,
                point,
                contents: annotation.contents().unwrap_or_default(),
            }))
        }
        PdfPageAnnotationType::Square => {
            let rect = pdf_to_rect(annotation.bounds().map_err(pdfium_err)?);
            let (stroke, fill) = read_stroke_fill_common(annotation);
            Ok(Some(AnnotSpec::Shape {
                page: page_no,
                shape: ShapeKind::Rect,
                rect,
                stroke,
                fill,
            }))
        }
        PdfPageAnnotationType::Circle => {
            // A foreign PDF's real Circle annotation — pdfium-render can
            // read but not create these. Mapped to `shape:ellipse` for
            // better read fidelity (see module doc comment).
            let rect = pdf_to_rect(annotation.bounds().map_err(pdfium_err)?);
            let (stroke, fill) = read_stroke_fill_common(annotation);
            Ok(Some(AnnotSpec::Shape {
                page: page_no,
                shape: ShapeKind::Ellipse,
                rect,
                stroke,
                fill,
            }))
        }
        PdfPageAnnotationType::Stamp => {
            let contents = annotation.contents().unwrap_or_default();
            match parse_shape_marker(&contents) {
                Some(shape) => {
                    let rect = pdf_to_rect(annotation.bounds().map_err(pdfium_err)?);
                    let (stroke, fill) = read_stroke_fill_from_objects(annotation);
                    Ok(Some(AnnotSpec::Shape {
                        page: page_no,
                        shape,
                        rect,
                        stroke,
                        fill,
                    }))
                }
                None => Ok(None), // Foreign stamp, not ours — skip.
            }
        }
        PdfPageAnnotationType::FreeText => {
            let rect = pdf_to_rect(annotation.bounds().map_err(pdfium_err)?);
            let text = annotation.contents().unwrap_or_default();
            Ok(Some(AnnotSpec::FreeText {
                page: page_no,
                rect,
                text,
                font_size: DEFAULT_FREE_TEXT_FONT_SIZE,
                color: DEFAULT_FREE_TEXT_COLOR.to_string(),
            }))
        }
        _ => Ok(None), // Link/Popup/Widget/XfaWidget/etc. — not a Rubrica kind.
    }
}

// --- writing annotations (create + update + revert share this) --------------

fn replace_attachment_points(
    ap: &mut PdfPageAnnotationAttachmentPoints<'static>,
    quadpoints: &[QuadPoint],
) -> Result<(), RubricaError> {
    let existing = ap.len();
    for (i, q) in quadpoints.iter().enumerate() {
        let pdf_q = quad_to_pdf(q);
        if i < existing {
            ap.set_attachment_point_at_index(i, pdf_q)
                .map_err(pdfium_err)?;
        } else {
            ap.create_attachment_point_at_end(pdf_q)
                .map_err(pdfium_err)?;
        }
    }
    Ok(())
}

/// Builds one *detached* [`PdfPagePathObject`] for the whole stroke (every
/// point, via one `move_to` + N `line_to` calls) and attaches it to
/// `objects` only once fully built. **Important**: mutating a
/// [`PdfPagePathObject`] (e.g. further `line_to` calls) *after* it has
/// already been attached via `add_path_object`/`create_path_object_line`
/// reliably segfaults — confirmed empirically, not assumed: PDFium's
/// `FPDFAnnot_AppendObject` does not keep the passed-in handle live as the
/// annotation's own canonical copy, so continuing to drive the original
/// Rust wrapper afterwards operates on stale memory. Build first, attach
/// last, always.
///
/// `annotation_opacity` (Ink's top-level `opacity`) is baked into this
/// stroke's own alpha channel rather than the Ink annotation's `/C`/`/CA` —
/// confirmed empirically that calling `PdfPageAnnotationCommon::
/// set_stroke_color` on an Ink annotation that already has content objects
/// reliably segfaults: `FPDFAnnot_SetColor` returns failure for an
/// annotation using appearance streams, and pdfium-render's fallback path
/// (`set_stroke_color_impl`) then calls `FPDFPageObj_SetStrokeColor` with
/// the *annotation's own* handle reinterpreted as if it were a page-object
/// handle — a real type confusion in that fallback, not safe for Ink. See
/// the module doc comment / wave report for the full writeup.
fn add_ink_stroke(
    doc: &PdfDocument<'static>,
    objects: &mut PdfPageAnnotationObjects<'static>,
    stroke: &Stroke,
    annotation_opacity: f64,
) -> Result<(), RubricaError> {
    if stroke.points.is_empty() {
        return Ok(());
    }
    let color = parse_color(&stroke.color, annotation_opacity)?;
    let width = PdfPoints::new(stroke.width as f32);
    let p0 = &stroke.points[0];

    let mut path = PdfPagePathObject::new(
        doc,
        PdfPoints::new(p0.x as f32),
        PdfPoints::new(p0.y as f32),
        Some(color),
        Some(width),
        None,
    )
    .map_err(pdfium_err)?;
    for p in &stroke.points[1..] {
        path.line_to(PdfPoints::new(p.x as f32), PdfPoints::new(p.y as f32))
            .map_err(pdfium_err)?;
    }
    objects.add_path_object(path).map_err(pdfium_err)?;
    Ok(())
}

fn clear_objects(objects: &mut PdfPageAnnotationObjects<'static>) -> Result<(), RubricaError> {
    while objects.len() > 0 {
        objects
            .remove_object_at_index(objects.len() - 1)
            .map_err(pdfium_err)?;
    }
    Ok(())
}

fn rebuild_ink_objects(
    doc: &PdfDocument<'static>,
    objects: &mut PdfPageAnnotationObjects<'static>,
    strokes: &[Stroke],
    annotation_opacity: f64,
) -> Result<(), RubricaError> {
    clear_objects(objects)?;
    for stroke in strokes {
        add_ink_stroke(doc, objects, stroke, annotation_opacity)?;
    }
    Ok(())
}

/// Adds a small filled triangular arrowhead pointing from `(x0,y0)` towards
/// `(x1,y1)`, at the `(x1,y1)` end. Proportions are a reasonable fixed size,
/// not derived from any spec — there's no CONTRACTS field for it.
fn add_arrowhead(
    doc: &PdfDocument<'static>,
    objects: &mut PdfPageAnnotationObjects<'static>,
    x0: PdfPoints,
    y0: PdfPoints,
    x1: PdfPoints,
    y1: PdfPoints,
    color: PdfColor,
) -> Result<(), RubricaError> {
    const HEAD_LEN: f32 = 10.0;
    const HEAD_HALF_WIDTH: f32 = 4.0;

    let dx = x1.value - x0.value;
    let dy = y1.value - y0.value;
    let len = (dx * dx + dy * dy).sqrt().max(1e-3);
    let ux = dx / len;
    let uy = dy / len;
    let px = -uy;
    let py = ux;

    let back_x = x1.value - ux * HEAD_LEN;
    let back_y = y1.value - uy * HEAD_LEN;
    let left_x = back_x + px * HEAD_HALF_WIDTH;
    let left_y = back_y + py * HEAD_HALF_WIDTH;
    let right_x = back_x - px * HEAD_HALF_WIDTH;
    let right_y = back_y - py * HEAD_HALF_WIDTH;

    let mut tri = PdfPagePathObject::new(
        doc,
        PdfPoints::new(x1.value),
        PdfPoints::new(y1.value),
        None,
        None,
        Some(color),
    )
    .map_err(pdfium_err)?;
    tri.line_to(PdfPoints::new(left_x), PdfPoints::new(left_y))
        .map_err(pdfium_err)?;
    tri.line_to(PdfPoints::new(right_x), PdfPoints::new(right_y))
        .map_err(pdfium_err)?;
    tri.close_path().map_err(pdfium_err)?;
    objects.add_path_object(tri).map_err(pdfium_err)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn rebuild_stamp_shape(
    doc: &PdfDocument<'static>,
    objects: &mut PdfPageAnnotationObjects<'static>,
    shape: ShapeKind,
    rect: &Rect,
    stroke: &StrokeFill,
    fill: &StrokeFill,
) -> Result<(), RubricaError> {
    clear_objects(objects)?;
    let pdf_rect = rect_to_pdf(rect);

    let stroke_color = match &stroke.color {
        Some(c) => Some(parse_color(c, stroke.opacity)?),
        None => None,
    };
    let stroke_width = if stroke_color.is_some() {
        Some(
            stroke
                .width
                .map(|w| PdfPoints::new(w as f32))
                .unwrap_or_else(|| PdfPoints::new(1.0)),
        )
    } else {
        None
    };
    let fill_color = match &fill.color {
        Some(c) => Some(parse_color(c, fill.opacity)?),
        None => None,
    };

    match shape {
        ShapeKind::Ellipse => {
            objects
                .create_path_object_ellipse(pdf_rect, stroke_color, stroke_width, fill_color)
                .map_err(pdfium_err)?;
        }
        ShapeKind::Line | ShapeKind::Arrow => {
            // Bottom-left -> top-right of `rect` — matches the R4 UI's
            // `AnnotationLayer.tsx` convention exactly; do not change this
            // without updating that file too.
            let (x0, y0, x1, y1) = (
                pdf_rect.left(),
                pdf_rect.bottom(),
                pdf_rect.right(),
                pdf_rect.top(),
            );
            let line_color = stroke_color.unwrap_or(PdfColor::new(0, 0, 0, 255));
            let line_width = stroke_width.unwrap_or_else(|| PdfPoints::new(1.0));
            objects
                .create_path_object_line(x0, y0, x1, y1, line_color, line_width)
                .map_err(pdfium_err)?;
            if matches!(shape, ShapeKind::Arrow) {
                add_arrowhead(doc, objects, x0, y0, x1, y1, line_color)?;
            }
        }
        ShapeKind::Rect => unreachable!("Rect shapes use a Square annotation, not Stamp"),
    }
    Ok(())
}

/// Creates a brand-new annotation of the kind matching `spec`'s discriminant
/// on `annotations`, leaving all of its own properties at PDFium's defaults
/// (an empty/zero-bounds shell) — [`write_spec`] fills those in right after,
/// on the same object, whether this is a fresh creation or an update.
fn create_blank_annotation_of_kind(
    page: &mut PdfPage<'static>,
    spec: &AnnotSpec,
) -> Result<(), RubricaError> {
    let annotations = page.annotations_mut();
    match spec {
        AnnotSpec::Highlight { .. } => {
            annotations
                .create_highlight_annotation()
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Underline { .. } => {
            annotations
                .create_underline_annotation()
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Strikeout { .. } => {
            annotations
                .create_strikeout_annotation()
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Ink { .. } => {
            annotations.create_ink_annotation().map_err(pdfium_err)?;
        }
        AnnotSpec::Note { contents, .. } => {
            annotations
                .create_text_annotation(contents)
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Shape { shape, .. } => match shape {
            ShapeKind::Rect => {
                annotations.create_square_annotation().map_err(pdfium_err)?;
            }
            ShapeKind::Ellipse | ShapeKind::Line | ShapeKind::Arrow => {
                annotations.create_stamp_annotation().map_err(pdfium_err)?;
            }
        },
        AnnotSpec::FreeText { text, .. } => {
            annotations
                .create_free_text_annotation(text)
                .map_err(pdfium_err)?;
        }
    }
    Ok(())
}

/// Writes every field of `spec` onto the EXISTING annotation at `index` —
/// geometry, color/opacity, contents. Used both right after creation (`spec`
/// is the freshly requested one) and by `annot_update`/its undo (`spec` is
/// the new or the previous state respectively) — one code path for all
/// three, so add/update/revert can never disagree about how a given
/// `AnnotSpec` maps onto PDFium properties. Assumes `spec`'s discriminant
/// matches the existing annotation's actual PDFium subtype (guaranteed by
/// this module's own callers — an update never changes an annotation's
/// kind).
fn write_spec(
    doc: &PdfDocument<'static>,
    page: &mut PdfPage<'static>,
    index: usize,
    spec: &AnnotSpec,
) -> Result<(), RubricaError> {
    let annotations = page.annotations_mut();
    let mut annotation = annotations.get(index).map_err(pdfium_err)?;

    match spec {
        AnnotSpec::Highlight {
            quadpoints,
            color,
            opacity,
            ..
        }
        | AnnotSpec::Underline {
            quadpoints,
            color,
            opacity,
            ..
        }
        | AnnotSpec::Strikeout {
            quadpoints,
            color,
            opacity,
            ..
        } => {
            {
                let ap = match annotation.annotation_type() {
                    PdfPageAnnotationType::Highlight => annotation
                        .as_highlight_annotation_mut()
                        .map(|a| a.attachment_points_mut()),
                    PdfPageAnnotationType::Underline => annotation
                        .as_underline_annotation_mut()
                        .map(|a| a.attachment_points_mut()),
                    PdfPageAnnotationType::Strikeout => annotation
                        .as_strikeout_annotation_mut()
                        .map(|a| a.attachment_points_mut()),
                    _ => None,
                }
                .ok_or_else(kind_mismatch)?;
                replace_attachment_points(ap, quadpoints)?;
            }
            annotation
                .set_stroke_color(parse_color(color, *opacity)?)
                .map_err(pdfium_err)?;
            annotation
                .set_bounds(rect_to_pdf(&bbox_of_quadpoints(quadpoints)))
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Ink {
            strokes, opacity, ..
        } => {
            {
                let a = annotation
                    .as_ink_annotation_mut()
                    .ok_or_else(kind_mismatch)?;
                // NOT `annotation.set_stroke_color(...)` here — see
                // `add_ink_stroke`'s doc comment for why that reliably
                // segfaults on an Ink annotation with content objects.
                // `opacity` is baked into each stroke's own alpha instead.
                rebuild_ink_objects(doc, a.objects_mut(), strokes, *opacity)?;
            }
            annotation
                .set_bounds(rect_to_pdf(&bbox_of_strokes(strokes)))
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Note {
            point, contents, ..
        } => {
            annotation.set_contents(contents).map_err(pdfium_err)?;
            let x = PdfPoints::new(point.x as f32);
            let y = PdfPoints::new((point.y - NOTE_ICON_SIZE_PT) as f32);
            let size = PdfPoints::new(NOTE_ICON_SIZE_PT as f32);
            annotation
                .set_bounds(PdfRect::new(y, x, y + size, x + size))
                .map_err(pdfium_err)?;
        }
        AnnotSpec::Shape {
            shape,
            rect,
            stroke,
            fill,
            ..
        } => match shape {
            ShapeKind::Rect => {
                annotation
                    .set_bounds(rect_to_pdf(rect))
                    .map_err(pdfium_err)?;
                if let Some(c) = &stroke.color {
                    annotation
                        .set_stroke_color(parse_color(c, stroke.opacity)?)
                        .map_err(pdfium_err)?;
                }
                if let Some(c) = &fill.color {
                    annotation
                        .set_fill_color(parse_color(c, fill.opacity)?)
                        .map_err(pdfium_err)?;
                }
            }
            ShapeKind::Ellipse | ShapeKind::Line | ShapeKind::Arrow => {
                annotation
                    .set_contents(&shape_marker(*shape))
                    .map_err(pdfium_err)?;
                annotation
                    .set_bounds(rect_to_pdf(rect))
                    .map_err(pdfium_err)?;
                let a = annotation
                    .as_stamp_annotation_mut()
                    .ok_or_else(kind_mismatch)?;
                rebuild_stamp_shape(doc, a.objects_mut(), *shape, rect, stroke, fill)?;
            }
        },
        AnnotSpec::FreeText { rect, .. } => {
            annotation
                .set_bounds(rect_to_pdf(rect))
                .map_err(pdfium_err)?;
            // `.text` is set once at creation (`create_free_text_annotation`)
            // and is never patchable (see `apply_patch`); `.font_size`/
            // `.color` have no public setter at all — see module doc
            // comment's FreeText compromise.
        }
    }
    Ok(())
}

fn create_annotation(
    doc: &PdfDocument<'static>,
    page: &mut PdfPage<'static>,
    spec: &AnnotSpec,
) -> Result<usize, RubricaError> {
    create_blank_annotation_of_kind(page, spec)?;
    let index = page.annotations().len() - 1;
    write_spec(doc, page, index, spec)?;
    Ok(index)
}

// --- Command impls -------------------------------------------------------------

/// `annot_add` — creates a brand-new annotation. Stashes the `(page, index)`
/// it landed at (append semantics — new annotations are always added at the
/// end of the page's annotation array) so `revert` knows what to delete.
#[derive(Debug, Serialize, Deserialize)]
pub struct AddAnnotCommand {
    spec: AnnotSpec,
    #[serde(skip)]
    created: Option<(u32, usize)>,
}

impl AddAnnotCommand {
    pub fn new(spec: AnnotSpec) -> Self {
        Self {
            spec,
            created: None,
        }
    }
}

#[typetag::serde]
impl Command for AddAnnotCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let page_no = spec_page(&self.spec);
        let mut page = get_page(doc, page_no)?;
        let index = create_annotation(doc, &mut page, &self.spec)?;
        self.created = Some((page_no, index));
        Ok(vec![page_no])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let (page_no, index) = self
            .created
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        let mut page = get_page(doc, page_no)?;
        check_index(&page, index)?;
        let annotations = page.annotations_mut();
        let annotation = annotations.get(index).map_err(pdfium_err)?;
        annotations
            .delete_annotation(annotation)
            .map_err(pdfium_err)?;
        Ok(vec![page_no])
    }
}

/// Whether `spec`'s kind draws its own appearance via `objects_mut()`
/// (Ink, and the Stamp-based Ellipse/Line/Arrow shapes). Confirmed
/// empirically (not assumed): removing an existing object from a *live*
/// Ink/Stamp annotation via `PdfPageObjectsCommon::remove_object_at_index`
/// (the only public way to clear old geometry before drawing new geometry)
/// reliably segfaults, even though the exact same removal on a annotation
/// that was JUST created (still empty) is fine, and even though deleting
/// the WHOLE annotation via `PdfPageAnnotations::delete_annotation` is
/// ALSO fine. So [`UpdateAnnotCommand`] never rewrites one of these kinds'
/// geometry in place — see its doc comment.
fn spec_draws_own_objects(spec: &AnnotSpec) -> bool {
    matches!(spec, AnnotSpec::Ink { .. })
        || matches!(
            spec,
            AnnotSpec::Shape {
                shape: ShapeKind::Ellipse | ShapeKind::Line | ShapeKind::Arrow,
                ..
            }
        )
}

/// Deletes the annotation at `index` and creates a fresh one from `spec` —
/// the safe way to replace an Ink/Stamp annotation's geometry (see
/// [`spec_draws_own_objects`]). Returns the new annotation's index (append
/// semantics — may differ from `index` if it wasn't already the last
/// annotation on the page; see the module doc comment's "Annotation
/// identity" section, an already-accepted limitation of this id scheme).
fn delete_and_recreate(
    doc: &PdfDocument<'static>,
    page: &mut PdfPage<'static>,
    index: usize,
    spec: &AnnotSpec,
) -> Result<usize, RubricaError> {
    {
        let annotations = page.annotations_mut();
        let annotation = annotations.get(index).map_err(pdfium_err)?;
        annotations
            .delete_annotation(annotation)
            .map_err(pdfium_err)?;
    }
    create_annotation(doc, page, spec)
}

/// `annot_update` — patches an existing annotation. For most kinds this
/// mutates the SAME annotation in place (index never changes) via
/// [`write_spec`]. For Ink and the Stamp-based shapes (Ellipse/Line/Arrow)
/// — see [`spec_draws_own_objects`] — it instead deletes the annotation and
/// creates a fresh one with the patched geometry, since rewriting their
/// drawn objects in place is not safe with this pdfium-render version.
/// `current_index` tracks where the live annotation actually sits once
/// this command has run at least once *in this process* (it starts at
/// `None` on a fresh/journal-replayed command, correctly falling back to
/// the originally-serialized `index`, which matches the live document's
/// state at that point precisely because replay reapplies every prior
/// command in the same order first).
#[derive(Debug, Serialize, Deserialize)]
pub struct UpdateAnnotCommand {
    page: u32,
    index: usize,
    patch: AnnotPatch,
    #[serde(skip)]
    previous: Option<AnnotSpec>,
    #[serde(skip)]
    current_index: Option<usize>,
}

impl UpdateAnnotCommand {
    pub fn new(page: u32, index: usize, patch: AnnotPatch) -> Self {
        Self {
            page,
            index,
            patch,
            previous: None,
            current_index: None,
        }
    }
}

#[typetag::serde]
impl Command for UpdateAnnotCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let target = self.current_index.unwrap_or(self.index);
        let mut page = get_page(doc, self.page)?;
        check_index(&page, target)?;
        let old_spec = {
            let current = page.annotations().get(target).map_err(pdfium_err)?;
            read_spec(&current, self.page)?.ok_or_else(|| {
                RubricaError::not_found(format!(
                    "no annotation with id \"{}\"",
                    make_annot_id(self.page, target)
                ))
            })?
        };
        self.previous = Some(old_spec.clone());
        let new_spec = apply_patch(&old_spec, &self.patch);

        if spec_draws_own_objects(&new_spec) {
            self.current_index = Some(delete_and_recreate(doc, &mut page, target, &new_spec)?);
        } else {
            write_spec(doc, &mut page, target, &new_spec)?;
            self.current_index = Some(target);
        }
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let old_spec = self
            .previous
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        let target = self
            .current_index
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        let mut page = get_page(doc, self.page)?;
        check_index(&page, target)?;

        if spec_draws_own_objects(&old_spec) {
            self.current_index = Some(delete_and_recreate(doc, &mut page, target, &old_spec)?);
        } else {
            write_spec(doc, &mut page, target, &old_spec)?;
            self.current_index = Some(target);
        }
        Ok(vec![self.page])
    }
}

/// `annot_delete` — removes an annotation. Stashes the full removed
/// [`AnnotSpec`] so `revert` can re-add it (via [`create_annotation`], the
/// same path `annot_add` uses) — the re-added annotation lands at the END of
/// the page's array, which may be a different index than before deletion if
/// other annotations were added/removed in between; see the module doc
/// comment's "Annotation identity" section on why that's an accepted
/// limitation of this id scheme, not a bug here.
#[derive(Debug, Serialize, Deserialize)]
pub struct DeleteAnnotCommand {
    page: u32,
    index: usize,
    #[serde(skip)]
    removed: Option<AnnotSpec>,
}

impl DeleteAnnotCommand {
    pub fn new(page: u32, index: usize) -> Self {
        Self {
            page,
            index,
            removed: None,
        }
    }
}

#[typetag::serde]
impl Command for DeleteAnnotCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut page = get_page(doc, self.page)?;
        check_index(&page, self.index)?;
        let annotations = page.annotations_mut();
        let annotation = annotations.get(self.index).map_err(pdfium_err)?;
        let spec = read_spec(&annotation, self.page)?.ok_or_else(|| {
            RubricaError::not_found(format!(
                "no annotation with id \"{}\"",
                make_annot_id(self.page, self.index)
            ))
        })?;
        self.removed = Some(spec);
        annotations
            .delete_annotation(annotation)
            .map_err(pdfium_err)?;
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let spec = self
            .removed
            .take()
            .ok_or_else(|| RubricaError::internal("revert called before apply"))?;
        let mut page = get_page(doc, self.page)?;
        create_annotation(doc, &mut page, &spec)?;
        Ok(vec![self.page])
    }
}

// --- fixture tests --------------------------------------------------------------
//
// Deliberately NOT `#[test]`-annotated and NOT `#[cfg(test)]`-gated — see
// `engine::history::test_commands`'s doc comment and `tests/engine_fixtures.rs`'s
// module doc comment for why: the vendored PDFium binary is not safe to touch
// from more than one OS thread, even one call at a time, even against
// different documents, and Rust's test harness gives every `#[test]` fn its
// own thread. `run_annotation_fixture_tests()` is the one entry point,
// intended to be called sequentially (on the same thread) alongside R2's own
// `engine_fixtures()` sub-tests and the pages/forms subagents' equivalents,
// from one combined `#[test]` fn in `tests/engine_fixtures.rs`.
pub mod fixture_tests {
    use std::path::{Path, PathBuf};
    use std::sync::Once;

    use super::{
        make_annot_id, parse_annot_id, AddAnnotCommand, DeleteAnnotCommand, UpdateAnnotCommand,
    };
    use crate::engine::document::DocumentSession;
    use crate::engine::pdfium;
    use crate::types::{
        AnnotPatch, AnnotSpec, Point, QuadPoint, Rect, ShapeKind, Stroke, StrokeFill,
    };

    static INIT: Once = Once::new();

    /// Idempotent: safe whether or not `tests/engine_fixtures.rs`'s own
    /// `init_test_journal_dir()` already ran first in this process.
    fn init_test_journal_dir() {
        INIT.call_once(|| {
            if std::env::var("RUBRICA_JOURNAL_DIR").is_err() {
                let dir = std::env::temp_dir().join(format!(
                    "rubrica-test-journal-annotations-{}",
                    std::process::id()
                ));
                let _ = std::fs::remove_dir_all(&dir);
                std::fs::create_dir_all(&dir).expect("create scratch journal dir");
                std::env::set_var("RUBRICA_JOURNAL_DIR", &dir);
            }
        });
    }

    fn repo_root() -> PathBuf {
        [env!("CARGO_MANIFEST_DIR"), ".."].iter().collect()
    }

    fn fixture(name: &str) -> PathBuf {
        repo_root().join("fixtures").join(name)
    }

    fn copy_fixture_to_scratch(name: &str) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join(name);
        std::fs::copy(fixture(name), &dest).expect("copy fixture into scratch dir");
        (dir, dest)
    }

    /// Re-opens `path` through the shared Pdfium handle (a fresh
    /// `PdfDocument` handle) and shells out to `scripts/verify-pdf.mjs` for
    /// the pdf-lib half — the same two-part portability gate
    /// `tests/engine_fixtures.rs::assert_portable` uses.
    fn assert_portable(path: &Path, expected_pages: u32) {
        let reopened = pdfium::shared()
            .load_pdf_from_file(path, None)
            .expect("saved PDF failed to re-open in PDFium");
        assert_eq!(reopened.pages().len() as u32, expected_pages);
        drop(reopened);

        let script = repo_root().join("scripts").join("verify-pdf.mjs");
        let status = std::process::Command::new("node")
            .arg(&script)
            .arg(path)
            .status()
            .expect("failed to launch `node scripts/verify-pdf.mjs` -- is Node on PATH?");
        assert!(
            status.success(),
            "scripts/verify-pdf.mjs reported a failure for {}",
            path.display()
        );
    }

    /// The single entry point this module exposes for the orchestrator's
    /// combined meta-test to call.
    pub fn run_annotation_fixture_tests() {
        init_test_journal_dir();

        round_trips_every_achievable_kind();
        bbox_transform_updates_highlight_and_ink();
        undo_redo_round_trips_add_update_delete();
        deletes_and_updates_object_bearing_kinds_without_crashing();
    }

    fn round_trips_every_achievable_kind() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let path_str = work_path.to_str().unwrap().to_string();

        let mut session = DocumentSession::open(&path_str).expect("text.pdf should open cleanly");

        let specs: Vec<AnnotSpec> = vec![
            AnnotSpec::Highlight {
                page: 0,
                quadpoints: vec![QuadPoint {
                    x1: 100.0,
                    y1: 100.0,
                    x2: 200.0,
                    y2: 100.0,
                    x3: 200.0,
                    y3: 120.0,
                    x4: 100.0,
                    y4: 120.0,
                }],
                color: "#ffff00".into(),
                opacity: 0.5,
            },
            AnnotSpec::Underline {
                page: 0,
                quadpoints: vec![QuadPoint {
                    x1: 100.0,
                    y1: 150.0,
                    x2: 200.0,
                    y2: 150.0,
                    x3: 200.0,
                    y3: 160.0,
                    x4: 100.0,
                    y4: 160.0,
                }],
                color: "#ff0000".into(),
                opacity: 1.0,
            },
            AnnotSpec::Strikeout {
                page: 0,
                quadpoints: vec![QuadPoint {
                    x1: 100.0,
                    y1: 200.0,
                    x2: 200.0,
                    y2: 200.0,
                    x3: 200.0,
                    y3: 210.0,
                    x4: 100.0,
                    y4: 210.0,
                }],
                color: "#00ff00".into(),
                opacity: 1.0,
            },
            AnnotSpec::Ink {
                page: 0,
                strokes: vec![Stroke {
                    points: vec![
                        Point { x: 50.0, y: 50.0 },
                        Point { x: 60.0, y: 70.0 },
                        Point { x: 80.0, y: 55.0 },
                    ],
                    width: 2.0,
                    color: "#0000ff".into(),
                }],
                opacity: 0.8,
            },
            AnnotSpec::Note {
                page: 0,
                point: Point { x: 300.0, y: 400.0 },
                contents: "hello note".into(),
            },
            AnnotSpec::Shape {
                page: 0,
                shape: ShapeKind::Rect,
                rect: Rect {
                    x: 10.0,
                    y: 10.0,
                    width: 50.0,
                    height: 30.0,
                },
                stroke: StrokeFill {
                    color: Some("#000000".into()),
                    opacity: 1.0,
                    width: Some(1.0),
                },
                fill: StrokeFill {
                    color: Some("#cccccc".into()),
                    opacity: 1.0,
                    width: None,
                },
            },
            AnnotSpec::Shape {
                page: 0,
                shape: ShapeKind::Ellipse,
                rect: Rect {
                    x: 100.0,
                    y: 300.0,
                    width: 60.0,
                    height: 40.0,
                },
                stroke: StrokeFill {
                    color: Some("#123456".into()),
                    opacity: 1.0,
                    width: Some(2.0),
                },
                fill: StrokeFill {
                    color: None,
                    opacity: 1.0,
                    width: None,
                },
            },
            AnnotSpec::Shape {
                page: 0,
                shape: ShapeKind::Line,
                rect: Rect {
                    x: 200.0,
                    y: 500.0,
                    width: 80.0,
                    height: 40.0,
                },
                stroke: StrokeFill {
                    color: Some("#654321".into()),
                    opacity: 1.0,
                    width: Some(1.5),
                },
                fill: StrokeFill {
                    color: None,
                    opacity: 1.0,
                    width: None,
                },
            },
            AnnotSpec::Shape {
                page: 0,
                shape: ShapeKind::Arrow,
                rect: Rect {
                    x: 300.0,
                    y: 600.0,
                    width: 70.0,
                    height: 35.0,
                },
                stroke: StrokeFill {
                    color: Some("#abcdef".into()),
                    opacity: 1.0,
                    width: Some(1.5),
                },
                fill: StrokeFill {
                    color: None,
                    opacity: 1.0,
                    width: None,
                },
            },
            AnnotSpec::FreeText {
                page: 0,
                rect: Rect {
                    x: 400.0,
                    y: 700.0,
                    width: 100.0,
                    height: 40.0,
                },
                text: "free text body".into(),
                font_size: 14.0,
                color: "#333333".into(),
            },
        ];

        for spec in &specs {
            session
                .commit(Box::new(AddAnnotCommand::new(spec.clone())))
                .expect("add annotation");
        }

        session.save(false).expect("save annotated document");
        drop(session);

        let reopened = pdfium::shared()
            .load_pdf_from_file(&work_path, None)
            .expect("reopen saved document with a fresh PdfDocument handle");
        let annots = super::list_annots(&reopened, 0).expect("list annotations on page 0");
        assert_eq!(
            annots.len(),
            specs.len(),
            "every achievable kind should round-trip back into annot_list, got: {annots:?}"
        );

        let highlight = annots
            .iter()
            .find(|a| matches!(a.spec, AnnotSpec::Highlight { .. }))
            .expect("highlight present");
        match &highlight.spec {
            AnnotSpec::Highlight {
                quadpoints,
                color,
                opacity,
                ..
            } => {
                assert_eq!(quadpoints.len(), 1);
                assert_eq!(color.to_lowercase(), "#ffff00");
                assert!(
                    (opacity - 0.5).abs() < 0.02,
                    "opacity {opacity} should be close to 0.5"
                );
            }
            _ => unreachable!(),
        }

        let ink = annots
            .iter()
            .find(|a| matches!(a.spec, AnnotSpec::Ink { .. }))
            .expect("ink present");
        match &ink.spec {
            AnnotSpec::Ink {
                strokes, opacity, ..
            } => {
                assert_eq!(strokes.len(), 1);
                assert_eq!(strokes[0].points.len(), 3);
                assert!((opacity - 0.8).abs() < 0.02);
            }
            _ => unreachable!(),
        }

        let note = annots
            .iter()
            .find(|a| matches!(a.spec, AnnotSpec::Note { .. }))
            .expect("note present");
        match &note.spec {
            AnnotSpec::Note {
                point, contents, ..
            } => {
                assert_eq!(contents, "hello note");
                assert!((point.x - 300.0).abs() < 0.5);
                assert!((point.y - 400.0).abs() < 0.5);
            }
            _ => unreachable!(),
        }

        let rect_shape = annots
            .iter()
            .find(|a| {
                matches!(
                    &a.spec,
                    AnnotSpec::Shape {
                        shape: ShapeKind::Rect,
                        ..
                    }
                )
            })
            .expect("rect shape present");
        match &rect_shape.spec {
            AnnotSpec::Shape {
                rect, stroke, fill, ..
            } => {
                assert!((rect.width - 50.0).abs() < 0.5);
                assert!(stroke.color.is_some());
                assert!(fill.color.is_some());
            }
            _ => unreachable!(),
        }

        let ellipse_shape = annots
            .iter()
            .find(|a| {
                matches!(
                    &a.spec,
                    AnnotSpec::Shape {
                        shape: ShapeKind::Ellipse,
                        ..
                    }
                )
            })
            .expect("ellipse shape present");
        match &ellipse_shape.spec {
            AnnotSpec::Shape { rect, stroke, .. } => {
                assert!((rect.width - 60.0).abs() < 0.5);
                assert!(stroke.color.is_some());
                assert!(
                    stroke.width.is_some(),
                    "stamp-based stroke width should round-trip"
                );
            }
            _ => unreachable!(),
        }

        annots
            .iter()
            .find(|a| {
                matches!(
                    &a.spec,
                    AnnotSpec::Shape {
                        shape: ShapeKind::Line,
                        ..
                    }
                )
            })
            .expect("line shape present");
        annots
            .iter()
            .find(|a| {
                matches!(
                    &a.spec,
                    AnnotSpec::Shape {
                        shape: ShapeKind::Arrow,
                        ..
                    }
                )
            })
            .expect("arrow shape present");

        let free_text = annots
            .iter()
            .find(|a| matches!(a.spec, AnnotSpec::FreeText { .. }))
            .expect("freeText present");
        match &free_text.spec {
            AnnotSpec::FreeText { rect, text, .. } => {
                assert_eq!(text, "free text body");
                assert!((rect.width - 100.0).abs() < 0.5);
            }
            _ => unreachable!(),
        }

        drop(reopened);
        assert_portable(&work_path, 3);
    }

    fn bbox_transform_updates_highlight_and_ink() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

        let highlight_spec = AnnotSpec::Highlight {
            page: 0,
            quadpoints: vec![QuadPoint {
                x1: 0.0,
                y1: 0.0,
                x2: 100.0,
                y2: 0.0,
                x3: 100.0,
                y3: 20.0,
                x4: 0.0,
                y4: 20.0,
            }],
            color: "#ff0000".into(),
            opacity: 1.0,
        };
        session
            .commit(Box::new(AddAnnotCommand::new(highlight_spec)))
            .expect("add highlight");
        let id = make_annot_id(0, 0);
        let (page, index) = parse_annot_id(&id).unwrap();
        let patch = AnnotPatch {
            color: None,
            opacity: None,
            contents: None,
            rect: Some(Rect {
                x: 1000.0,
                y: 1000.0,
                width: 200.0,
                height: 40.0,
            }),
        };
        session
            .commit(Box::new(UpdateAnnotCommand::new(page, index, patch)))
            .expect("update highlight rect");

        let annots =
            super::list_annots(session.document(), 0).expect("list after highlight update");
        let highlight = annots
            .iter()
            .find(|a| a.annot_id == id)
            .expect("highlight still at same id");
        match &highlight.spec {
            AnnotSpec::Highlight { quadpoints, .. } => {
                let xs: Vec<f64> = quadpoints
                    .iter()
                    .flat_map(|q| [q.x1, q.x2, q.x3, q.x4])
                    .collect();
                let ys: Vec<f64> = quadpoints
                    .iter()
                    .flat_map(|q| [q.y1, q.y2, q.y3, q.y4])
                    .collect();
                let min_x = xs.iter().cloned().fold(f64::INFINITY, f64::min);
                let max_x = xs.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                let min_y = ys.iter().cloned().fold(f64::INFINITY, f64::min);
                let max_y = ys.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
                assert!((min_x - 1000.0).abs() < 0.5, "min_x {min_x}");
                assert!((min_y - 1000.0).abs() < 0.5, "min_y {min_y}");
                assert!((max_x - 1200.0).abs() < 0.5, "max_x {max_x}");
                assert!((max_y - 1040.0).abs() < 0.5, "max_y {max_y}");
            }
            _ => unreachable!(),
        }

        let ink_spec = AnnotSpec::Ink {
            page: 0,
            strokes: vec![Stroke {
                points: vec![
                    Point { x: 0.0, y: 0.0 },
                    Point { x: 10.0, y: 0.0 },
                    Point { x: 10.0, y: 10.0 },
                ],
                width: 1.0,
                color: "#000000".into(),
            }],
            opacity: 1.0,
        };
        session
            .commit(Box::new(AddAnnotCommand::new(ink_spec)))
            .expect("add ink");
        let ink_id = make_annot_id(0, 1);
        let (p2, i2) = parse_annot_id(&ink_id).unwrap();
        let ink_patch = AnnotPatch {
            color: None,
            opacity: None,
            contents: None,
            rect: Some(Rect {
                x: 500.0,
                y: 500.0,
                width: 20.0,
                height: 20.0,
            }),
        };
        session
            .commit(Box::new(UpdateAnnotCommand::new(p2, i2, ink_patch)))
            .expect("update ink rect");
        let annots = super::list_annots(session.document(), 0).expect("list after ink update");
        let ink = annots
            .iter()
            .find(|a| a.annot_id == ink_id)
            .expect("ink still at same id");
        match &ink.spec {
            AnnotSpec::Ink { strokes, .. } => {
                let pts = &strokes[0].points;
                assert_eq!(pts.len(), 3);
                assert!((pts[0].x - 500.0).abs() < 0.5 && (pts[0].y - 500.0).abs() < 0.5);
                assert!((pts[2].x - 520.0).abs() < 0.5 && (pts[2].y - 520.0).abs() < 0.5);
            }
            _ => unreachable!(),
        }
    }

    fn undo_redo_round_trips_add_update_delete() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

        let spec = AnnotSpec::Note {
            page: 0,
            point: Point { x: 10.0, y: 10.0 },
            contents: "v1".into(),
        };
        session
            .commit(Box::new(AddAnnotCommand::new(spec)))
            .expect("add");
        assert_eq!(super::list_annots(session.document(), 0).unwrap().len(), 1);

        let id = make_annot_id(0, 0);
        let (page, index) = parse_annot_id(&id).unwrap();
        let patch = AnnotPatch {
            color: None,
            opacity: None,
            contents: Some("v2".into()),
            rect: None,
        };
        session
            .commit(Box::new(UpdateAnnotCommand::new(page, index, patch)))
            .expect("update");
        let annots = super::list_annots(session.document(), 0).unwrap();
        match &annots[0].spec {
            AnnotSpec::Note { contents, .. } => assert_eq!(contents, "v2"),
            _ => unreachable!(),
        }

        session
            .commit(Box::new(DeleteAnnotCommand::new(page, index)))
            .expect("delete");
        assert!(super::list_annots(session.document(), 0)
            .unwrap()
            .is_empty());

        session
            .undo()
            .expect("undo delete")
            .expect("something to undo");
        let annots = super::list_annots(session.document(), 0).unwrap();
        assert_eq!(annots.len(), 1);
        match &annots[0].spec {
            AnnotSpec::Note { contents, .. } => assert_eq!(contents, "v2"),
            _ => unreachable!(),
        }

        session
            .undo()
            .expect("undo update")
            .expect("something to undo");
        let annots = super::list_annots(session.document(), 0).unwrap();
        match &annots[0].spec {
            AnnotSpec::Note { contents, .. } => assert_eq!(contents, "v1"),
            _ => unreachable!(),
        }

        session
            .undo()
            .expect("undo add")
            .expect("something to undo");
        assert!(super::list_annots(session.document(), 0)
            .unwrap()
            .is_empty());

        session
            .redo()
            .expect("redo add")
            .expect("something to redo");
        session
            .redo()
            .expect("redo update")
            .expect("something to redo");
        session
            .redo()
            .expect("redo delete")
            .expect("something to redo");
        assert!(super::list_annots(session.document(), 0)
            .unwrap()
            .is_empty());
    }

    /// Ink and the Stamp-based shapes (Ellipse/Line/Arrow) draw their own
    /// appearance via `objects_mut()` — the specific reason
    /// `UpdateAnnotCommand` deletes-and-recreates instead of mutating in
    /// place for these kinds (see `spec_draws_own_objects`'s doc comment).
    /// This exercises exactly the operations that reasoning depends on:
    /// deleting a *non-empty* Ink/Stamp annotation, and updating a
    /// Stamp-based Ellipse's geometry (which internally deletes+recreates
    /// too).
    fn deletes_and_updates_object_bearing_kinds_without_crashing() {
        let (_dir, work_path) = copy_fixture_to_scratch("text.pdf");
        let mut session = DocumentSession::open(work_path.to_str().unwrap()).expect("open");

        let ink_spec = AnnotSpec::Ink {
            page: 0,
            strokes: vec![Stroke {
                points: vec![Point { x: 5.0, y: 5.0 }, Point { x: 15.0, y: 25.0 }],
                width: 1.0,
                color: "#112233".into(),
            }],
            opacity: 1.0,
        };
        session
            .commit(Box::new(AddAnnotCommand::new(ink_spec)))
            .expect("add ink");

        let ellipse_spec = AnnotSpec::Shape {
            page: 0,
            shape: ShapeKind::Ellipse,
            rect: Rect {
                x: 50.0,
                y: 50.0,
                width: 40.0,
                height: 30.0,
            },
            stroke: StrokeFill {
                color: Some("#445566".into()),
                opacity: 1.0,
                width: Some(1.0),
            },
            fill: StrokeFill {
                color: None,
                opacity: 1.0,
                width: None,
            },
        };
        session
            .commit(Box::new(AddAnnotCommand::new(ellipse_spec)))
            .expect("add ellipse");
        assert_eq!(super::list_annots(session.document(), 0).unwrap().len(), 2);

        // Update the Stamp-based ellipse's rect -- exercises the
        // delete-and-recreate path on a NON-EMPTY Stamp annotation.
        let ellipse_id = make_annot_id(0, 1);
        let (page, index) = parse_annot_id(&ellipse_id).unwrap();
        let patch = AnnotPatch {
            color: None,
            opacity: None,
            contents: None,
            rect: Some(Rect {
                x: 200.0,
                y: 200.0,
                width: 80.0,
                height: 60.0,
            }),
        };
        session
            .commit(Box::new(UpdateAnnotCommand::new(page, index, patch)))
            .expect("update ellipse rect");
        let annots = super::list_annots(session.document(), 0).unwrap();
        let ellipse = annots
            .iter()
            .find(|a| {
                matches!(
                    &a.spec,
                    AnnotSpec::Shape {
                        shape: ShapeKind::Ellipse,
                        ..
                    }
                )
            })
            .expect("ellipse still present after update");
        match &ellipse.spec {
            AnnotSpec::Shape { rect, .. } => {
                assert!((rect.x - 200.0).abs() < 0.5);
                assert!((rect.width - 80.0).abs() < 0.5);
            }
            _ => unreachable!(),
        }

        // Delete both the Ink and the (now possibly-reindexed) ellipse --
        // exercises `delete_annotation` on NON-EMPTY Ink/Stamp annotations.
        // Highest index first within this one batch, since deleting a
        // lower index shifts every later one down by one (an in-session id
        // becomes stale the moment an earlier annotation on the same page
        // is removed -- see the module doc comment's "Annotation identity"
        // section; re-`list_annots` between deletes in real UI code).
        let mut annots = super::list_annots(session.document(), 0).unwrap();
        annots.sort_by_key(|a| parse_annot_id(&a.annot_id).unwrap().1);
        for annot in annots.iter().rev() {
            let (p, i) = parse_annot_id(&annot.annot_id).unwrap();
            session
                .commit(Box::new(DeleteAnnotCommand::new(p, i)))
                .expect("delete object-bearing annotation");
        }
        assert!(super::list_annots(session.document(), 0)
            .unwrap()
            .is_empty());
    }
}
