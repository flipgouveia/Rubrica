//! Backs the `rubrica-tile://` and `rubrica-thumb://` custom protocols
//! (CONTRACTS §3) for real — see `src-tauri/API.md`'s "Tile pipeline"
//! section for the rendering technique (a fixed-size destination bitmap
//! plus `PdfRenderConfig::set_origin`, so a single 512×512 tile never
//! requires allocating a full-page bitmap) and the cache design.

use std::io::Cursor;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use image::{ImageFormat, RgbaImage};
use lru::LruCache;
use pdfium_render::prelude::*;

use crate::engine::document::{DocumentSession, SessionStore};
use crate::types::{DocId, RubricaError};

pub const TILE_SIZE: u32 = 512;
/// Thumbnails fit within this many pixels on their longest side.
pub const THUMB_MAX: u32 = 160;

/// CONTRACTS §3's fixed zoom bucket list — index into this, never an
/// arbitrary `f64`, so the tile cache key stays small and hashable.
pub const ZOOM_BUCKETS: [f64; 8] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 3.0, 4.0];

pub fn zoom_bucket_index(bucket: f64) -> Option<u8> {
    ZOOM_BUCKETS
        .iter()
        .position(|b| (*b - bucket).abs() < 1e-6)
        .map(|i| i as u8)
}

/// `(doc, page, zoom-bucket index, tile x, tile y, revision)`. Revision is
/// part of the key so a stale tile is simply never requested again once the
/// frontend re-fetches at a new `?rev=` — see `TileCache::invalidate_pages`
/// for the *active* half of invalidation (freeing memory immediately for
/// exactly the pages a mutation just touched, rather than waiting on LRU
/// pressure to evict them).
type TileKey = (DocId, u32, u8, u32, u32, u32);

const CACHE_CAPACITY: usize = 1024;

pub struct TileCache(Mutex<LruCache<TileKey, Arc<Vec<u8>>>>);

impl Default for TileCache {
    fn default() -> Self {
        Self(Mutex::new(LruCache::new(
            NonZeroUsize::new(CACHE_CAPACITY).expect("capacity is a nonzero literal"),
        )))
    }
}

impl TileCache {
    fn get(&self, key: &TileKey) -> Option<Arc<Vec<u8>>> {
        self.0.lock().ok()?.get(key).cloned()
    }

    fn put(&self, key: TileKey, bytes: Arc<Vec<u8>>) {
        if let Ok(mut cache) = self.0.lock() {
            cache.put(key, bytes);
        }
    }

    /// Evicts every cached tile — at any revision — for `doc_id`'s given
    /// pages. Called by mutation command handlers (`commands/history.rs`'s
    /// `history_undo`/`history_redo`, and any future wave-2 mutation
    /// command) with the `invalidatedPages` a `MutationResult` just
    /// reported.
    pub fn invalidate_pages(&self, doc_id: &str, pages: &[u32]) {
        let Ok(mut cache) = self.0.lock() else { return };
        let stale: Vec<TileKey> = cache
            .iter()
            .filter(|(key, _)| key.0 == doc_id && pages.contains(&key.1))
            .map(|(key, _)| key.clone())
            .collect();
        for key in stale {
            cache.pop(&key);
        }
    }
}

/// PNG-encodes a raw RGBA buffer. Pure CPU (no PDFium), so tile/thumbnail
/// callers run this OFF the PDFium owner thread — they rasterize inside a
/// `SessionStore::with_session` closure (owner thread), hand the detached
/// RGBA bytes back, and encode here — keeping the owner thread doing only
/// PDFium work and never blocked on DEFLATE.
fn encode_png_rgba(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>, RubricaError> {
    let rgba: RgbaImage = RgbaImage::from_raw(width, height, rgba).ok_or_else(|| {
        RubricaError::internal("rendered bitmap dimensions did not match its buffer")
    })?;
    let mut bytes = Vec::new();
    rgba.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|e| RubricaError::internal(e.to_string()))?;
    Ok(bytes)
}

/// Detaches a rendered `PdfBitmap` into `(width, height, rgba)`. Must be
/// called on the owner thread (it touches the PDFium bitmap); the returned
/// `Vec` is an owned copy safe to encode anywhere.
fn detach_rgba(bitmap: &PdfBitmap) -> (u32, u32, Vec<u8>) {
    (
        bitmap.width() as u32,
        bitmap.height() as u32,
        bitmap.as_rgba_bytes(),
    )
}

/// Encodes a `PdfBitmap` to PNG in one step — used by `render_page_at_dpi`,
/// which already runs inside a `with_session` closure (print is infrequent,
/// so encoding there on the owner thread is fine). Tile/thumbnail rendering
/// splits `detach_rgba` (owner thread) from `encode_png_rgba` (off-thread).
fn encode_png(bitmap: &PdfBitmap) -> Result<Vec<u8>, RubricaError> {
    let (width, height, rgba) = detach_rgba(bitmap);
    encode_png_rgba(width, height, rgba)
}

/// Renders (or serves from cache) the 512×512 PNG tile for
/// `rubrica-tile://<doc_id>/<page>/<bucket>/<x>/<y>?rev=<revision>`.
///
/// `revision` isn't used to alter rendering — the document is rendered as
/// it currently is regardless — it only participates in the cache key, so a
/// caller that races a mutation always either gets the pre- or post-mutation
/// tile, never a torn one, and never a stale one once it re-requests at the
/// new revision.
#[allow(clippy::too_many_arguments)]
pub fn render_tile(
    sessions: &SessionStore,
    cache: &TileCache,
    doc_id: &str,
    page: u32,
    bucket: f64,
    x: u32,
    y: u32,
    revision: u32,
) -> Result<Arc<Vec<u8>>, RubricaError> {
    let bucket_index = zoom_bucket_index(bucket)
        .ok_or_else(|| RubricaError::invalid_arg(format!("unknown zoom bucket {bucket}")))?;
    let key: TileKey = (doc_id.to_string(), page, bucket_index, x, y, revision);
    if let Some(bytes) = cache.get(&key) {
        return Ok(bytes);
    }

    // Rasterize on the PDFium owner thread (all it touches is `session`),
    // then encode the detached RGBA off that thread just below — see
    // `SessionStore`'s doc comment for why every PDFium call funnels here.
    let (width, height, rgba) = sessions.with_session(doc_id, move |session| {
        let pdf_page = session
            .document()
            .pages()
            .get(page as PdfPageIndex)
            .map_err(|e| RubricaError::invalid_arg(e.to_string()))?;

        let page_px_w = (pdf_page.width().value as f64 * bucket).round().max(1.0) as i32;
        let page_px_h = (pdf_page.height().value as f64 * bucket).round().max(1.0) as i32;

        let mut bitmap = PdfBitmap::empty(
            TILE_SIZE as i32,
            TILE_SIZE as i32,
            PdfBitmapFormat::default(),
        )
        .map_err(|e| RubricaError::internal(e.to_string()))?;
        let config = PdfRenderConfig::new()
            .set_target_width(page_px_w)
            .set_target_height(page_px_h)
            .set_origin(-((x * TILE_SIZE) as i32), -((y * TILE_SIZE) as i32));
        pdf_page
            .render_into_bitmap_with_config(&mut bitmap, &config)
            .map_err(|e| RubricaError::internal(e.to_string()))?;
        Ok::<_, RubricaError>(detach_rgba(&bitmap))
    })??;

    let bytes = Arc::new(encode_png_rgba(width, height, rgba)?);
    cache.put(key, bytes.clone());
    Ok(bytes)
}

/// Renders the thumbnail for `rubrica-thumb://<doc_id>/<page>?rev=<revision>`
/// — the whole page scaled to fit `THUMB_MAX` pixels on its longest side.
/// Not cached: thumbnails are requested far less often than tiles (once per
/// page, typically for a rail the user isn't continuously scrolling at
/// pixel granularity), so the `TileCache` stays tile-only.
pub fn render_thumb(
    sessions: &SessionStore,
    doc_id: &str,
    page: u32,
) -> Result<Vec<u8>, RubricaError> {
    // Rasterize on the owner thread, encode off it — same split as
    // `render_tile`.
    let (width, height, rgba) = sessions.with_session(doc_id, move |session| {
        let pdf_page = session
            .document()
            .pages()
            .get(page as PdfPageIndex)
            .map_err(|e| RubricaError::invalid_arg(e.to_string()))?;

        let config = if pdf_page.width() > pdf_page.height() {
            PdfRenderConfig::new().set_target_width(THUMB_MAX as i32)
        } else {
            PdfRenderConfig::new().set_target_height(THUMB_MAX as i32)
        };
        let bitmap = pdf_page
            .render_with_config(&config)
            .map_err(|e| RubricaError::internal(e.to_string()))?;
        Ok::<_, RubricaError>(detach_rgba(&bitmap))
    })??;

    encode_png_rgba(width, height, rgba)
}

/// Renders one page at `dpi` dots per inch (72 DPI == 1 PDF point per
/// pixel), returning PNG bytes — the CONTRACTS `print_render` command's
/// unit of work (`commands/app.rs` handles the temp-file I/O; this stays
/// pure rendering, alongside the tile/thumbnail renderers above).
pub fn render_page_at_dpi(
    session: &DocumentSession,
    page: u32,
    dpi: u32,
) -> Result<Vec<u8>, RubricaError> {
    let pdf_page = session
        .document()
        .pages()
        .get(page as PdfPageIndex)
        .map_err(|e| RubricaError::invalid_arg(e.to_string()))?;

    let scale = dpi as f64 / 72.0;
    let width = (pdf_page.width().value as f64 * scale).round().max(1.0) as i32;
    let height = (pdf_page.height().value as f64 * scale).round().max(1.0) as i32;
    let config = PdfRenderConfig::new()
        .set_target_width(width)
        .set_target_height(height);
    let bitmap = pdf_page
        .render_with_config(&config)
        .map_err(|e| RubricaError::internal(e.to_string()))?;
    encode_png(&bitmap)
}
