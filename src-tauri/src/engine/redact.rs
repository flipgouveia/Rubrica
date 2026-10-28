//! True redaction: removes underlying text/image objects and rasterizes the region — R6's
//! module. Whiteout is deliberately NOT here: it's an opaque `shape` annotation (see
//! `crate::types::AnnotSpec`), not a page-content mutation at all.
//!
//! ## Algorithm
//!
//! For each marked rect on a page, `redact_apply`:
//!
//! 1. Removes every text or image object whose bounds overlap *any* of the marked rects
//!    (whole objects, not partial glyph runs — an object that only partially overlaps a rect
//!    is removed entirely, the same simplification most redaction tools make; see the module
//!    doc comment in `engine::textedit` for the object-capture/restore machinery this reuses).
//! 2. Renders the page (now with that content gone) to a bitmap at [`RASTER_SCALE`].
//! 3. For each rect, crops the corresponding pixels out of that render and inserts them as a
//!    new image object covering exactly that rect.
//!
//! Rendering *after* removal (not before, and not with a solid fill drawn first) is the point:
//! whatever is left behind — typically blank page background — is what gets baked in, so the
//! saved file contains neither the original vector text/image content nor any drawing operator
//! that reconstructs it. This is also what makes "content is gone, not covered" (the
//! whiteout-vs-redaction distinction `docs/ARCHITECTURE.md` calls out) literally true: nothing
//! is painted *over* the marked area, the area is genuinely re-rendered from what remains.
//! Flattening it to an image (rather than leaving the post-removal vector state as-is) exists
//! to guarantee no partial glyph fragment or anti-aliasing artifact from the removed objects
//! survives as recoverable vector data — the byte-search test only passes if there is truly
//! nothing left to find.

use pdfium_render::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::history::Command;
use crate::engine::textedit::{
    capture_removable, get_page, pdfium_err, remove_object_at_index_leaking, restore_removed,
    RemovedObject,
};
use crate::types::{Rect, RubricaError};

/// PDF points to pixels for the redaction patch — matches the highest zoom bucket the tile
/// pipeline supports (`engine::tiles::ZOOM_BUCKETS`'s `4.0`, i.e. 4 pixels per point), so the
/// patch stays crisp even fully zoomed in rather than only looking right at 1x.
const RASTER_SCALE: f32 = 4.0;

fn to_pdf_rect(rect: &Rect) -> PdfRect {
    PdfRect::new(
        PdfPoints::new(rect.y as f32),
        PdfPoints::new(rect.x as f32),
        PdfPoints::new((rect.y + rect.height) as f32),
        PdfPoints::new((rect.x + rect.width) as f32),
    )
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RedactCommand {
    page: u32,
    rects: Vec<Rect>,
    /// See `engine::textedit::RemovedObject`'s doc comment for why this is sound despite not
    /// being `Serialize` — `revert()` only ever runs in the same live process as the matching
    /// `apply()`.
    #[serde(skip)]
    removed: Vec<RemovedObject>,
    /// How many image objects `apply()` appended as redaction patches — always the last objects
    /// on the page at the moment `apply()` finished, so `revert()` can remove exactly them.
    #[serde(default)]
    patch_count: usize,
}

impl RedactCommand {
    pub fn new(page: u32, rects: Vec<Rect>) -> Self {
        Self {
            page,
            rects,
            removed: Vec::new(),
            patch_count: 0,
        }
    }
}

#[typetag::serde]
impl Command for RedactCommand {
    fn apply(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut page = get_page(doc, self.page)?;
        let target_rects: Vec<PdfRect> = self.rects.iter().map(to_pdf_rect).collect();

        let mut match_indices = Vec::new();
        for (index, obj) in page.objects().iter().enumerate() {
            if !matches!(
                obj.object_type(),
                PdfPageObjectType::Text | PdfPageObjectType::Image
            ) {
                continue;
            }
            if target_rects.iter().any(|r| obj.does_overlap_rect(r)) {
                match_indices.push(index);
            }
        }

        // Capture + remove from the highest index down, so indices captured earlier in this
        // pass (all lower) never shift out from under us.
        let mut removed = Vec::with_capacity(match_indices.len());
        for &index in match_indices.iter().rev() {
            let snapshot = {
                let obj = page.objects().get(index).map_err(pdfium_err)?;
                capture_removable(&obj)?
            };
            removed.push(snapshot);
            remove_object_at_index_leaking(&mut page, index)?;
        }
        removed.reverse();

        let page_w = page.width().value;
        let page_h = page.height().value;
        let img_w = ((page_w * RASTER_SCALE).round().max(1.0)) as u32;
        let img_h = ((page_h * RASTER_SCALE).round().max(1.0)) as u32;
        let config = PdfRenderConfig::new()
            .set_target_width(img_w as i32)
            .set_target_height(img_h as i32);
        // Scoped so the rendered PdfBitmap (which, like PdfPage, has a Drop impl and so keeps
        // its — elided — borrow of `page` alive for its whole scope, not just its last use)
        // releases `page` before the patch-insertion loop below needs to mutate it again.
        let full = {
            let bitmap = page.render_with_config(&config).map_err(pdfium_err)?;
            bitmap.as_image().map_err(pdfium_err)?
        };

        let mut patch_count = 0usize;
        for rect in &self.rects {
            let px = ((rect.x as f32) * RASTER_SCALE)
                .round()
                .clamp(0.0, img_w as f32) as u32;
            let py = (((page_h as f64 - (rect.y + rect.height)) as f32) * RASTER_SCALE)
                .round()
                .clamp(0.0, img_h as f32) as u32;
            let pw = (((rect.width as f32) * RASTER_SCALE).round() as u32)
                .min(img_w.saturating_sub(px))
                .max(1);
            let ph = (((rect.height as f32) * RASTER_SCALE).round() as u32)
                .min(img_h.saturating_sub(py))
                .max(1);

            let cropped = image::imageops::crop_imm(&full, px, py, pw, ph).to_image();
            let cropped = image::DynamicImage::ImageRgba8(cropped);

            page.objects_mut()
                .create_image_object(
                    PdfPoints::new(rect.x as f32),
                    PdfPoints::new(rect.y as f32),
                    &cropped,
                    Some(PdfPoints::new(rect.width as f32)),
                    Some(PdfPoints::new(rect.height as f32)),
                )
                .map_err(pdfium_err)?;
            patch_count += 1;
        }

        self.removed = removed;
        self.patch_count = patch_count;
        Ok(vec![self.page])
    }

    fn revert(&mut self, doc: &mut PdfDocument<'static>) -> Result<Vec<u32>, RubricaError> {
        let mut page = get_page(doc, self.page)?;

        let len = page.objects().len();
        let start = len.saturating_sub(self.patch_count);
        for index in (start..len).rev() {
            remove_object_at_index_leaking(&mut page, index)?;
        }
        self.patch_count = 0;

        for item in std::mem::take(&mut self.removed) {
            restore_removed(&mut page, item)?;
        }

        Ok(vec![self.page])
    }
}
