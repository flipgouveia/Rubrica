//! Handlers for the `rubrica-tile://` / `rubrica-thumb://` / `rubrica-print://`
//! custom protocols (CONTRACTS §3). Kept separate from `engine::tiles` (which does the actual
//! rendering and knows nothing about Tauri or HTTP) for the same reason
//! `commands/` is separate from `engine/`: this is the Tauri-facing glue
//! layer, parsing a request URL and turning a `RubricaError` into an HTTP
//! status, not engine logic.
//!
//! **Wire format is platform-specific — read this before touching either
//! side of the protocol.** `rubrica-tile://<docId>/<page>/...` is the
//! *logical* shape CONTRACTS §3 describes; it is not the literal string the
//! webview ever requests. Per [`tauri::Builder::register_asynchronous_uri_scheme_protocol`]'s
//! own docs, a custom scheme reaches the page as:
//!
//! - Windows and Android: `http://<scheme>.localhost/<path>` — a tile is
//!   `http://rubrica-tile.localhost/<docId>/<page>/<bucket>/<x>/<y>?rev=<n>`
//! - macOS, iOS and Linux: `<scheme>://localhost/<path>`
//!
//! Nothing rewrites a literal `<img src="rubrica-tile://...">` into that
//! form: WebView2 simply has no handler for such a scheme, shows its
//! broken-image icon, and this module is never called at all — the
//! release-blocking bug R8 found (see `docs/BACKLOG.md`). The frontend
//! therefore builds every tile/thumbnail URL through
//! `src/ipc/protocolUrl.ts`, which delegates the platform decision to
//! Tauri's own `convertFileSrc(path, scheme)` helper. By the time a request
//! reaches this module Tauri has normalised it back to
//! `rubrica-tile://localhost/<docId>/...` on every platform, so
//! `request.uri().host()` is always `"localhost"`, never the `docId` — every
//! field lives in `request.uri().path()`, with the `docId` as its first
//! segment.
//!
//! **Threading (why these are `register_asynchronous_uri_scheme_protocol`,
//! not the synchronous variant).** A synchronous handler runs inline on
//! WebView2's UI thread, so a page's whole tile burst — PDFium render + PNG
//! encode per tile — executes there and stalls input/IPC/event delivery
//! until it finishes. For the tiled viewer that is the wrong place for the
//! work: ARCHITECTURE.md's whole premise is that scrolling a 500-page
//! document stays smooth, which a UI thread blocked on rendering cannot do.
//!
//! So the UI thread only parses the URL and enqueues onto ONE dedicated,
//! long-lived `rubrica-render` thread (`render_queue` below), which calls the
//! async responder when the PNG is ready. The render thread itself does NOT
//! touch PDFium: `render_tile`/`render_thumb` rasterize through
//! `SessionStore::with_session`, so the PDFium raster runs on the single
//! `SessionStore` owner thread (the one thread that ever calls PDFium — see
//! `engine::document::SessionStore`), and the render thread only does the
//! pure-CPU PNG encode of the detached RGBA off that owner thread. Net effect:
//! the UI thread is never blocked by rendering, PDFium stays on exactly one
//! thread identity (the `agents/reports/r2-report.md` requirement), and the
//! PNG DEFLATE runs in parallel with the owner thread's next raster.
//!
//! **What this does and does not fix for the e2e suite (see `docs/BACKLOG.md`).**
//! The single-PDFium-thread actor removed the multi-thread PDFium hazard the
//! tile-URL bug had masked. It did NOT make the suite's five interactive
//! mutation specs (`01`–`05`) pass: once real rendering happens at all, the
//! `tauri-driver`/WebView2 automation session drops ("browser closed the
//! connection") shortly after the first mutation's re-render — reproducibly,
//! and independently of how rendering is threaded (sync-on-UI-thread, a
//! dedicated thread, the tokio pool, and this single-owner actor all fail
//! identically; only stubbing the renderer to a 1×1 PNG makes them pass). The
//! real app renders correctly (a `PrintWindow` capture and the `09-render`
//! spec both confirm real page pixels), so this is a limitation of driving
//! this app under `tauri-driver` while it does real per-tile rendering during
//! active interaction, not an app defect.

use std::fs;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::mpsc::{channel, Sender};
use std::sync::OnceLock;
use std::thread;

use tauri::http::{Request, Response, StatusCode, Uri};
use tauri::{AppHandle, Manager, UriSchemeResponder};

use crate::commands::app::print_render_path;
use crate::engine::document::SessionStore;
use crate::engine::tiles::{self, TileCache};
use crate::types::{RubricaError, RubricaErrorCode};

/// The page (`http://tauri.localhost` in a Windows build) and these protocols
/// (`http://rubrica-tile.localhost`, ...) are different origins. A plain
/// `<img>` doesn't care, but reading a tile's pixels back — `fetch()` +
/// canvas, which `e2e/specs/09-render.e2e.mjs` does to prove real content
/// arrived, not just a decodable placeholder — is a CORS request that needs
/// this header. Same header Tauri's own `asset://` protocol sends; the only
/// code that can ever run in this webview is Rubrica's bundled frontend, so
/// a wildcard grants nothing new.
const CORS_ALLOW_ANY_ORIGIN: (&str, &str) = ("Access-Control-Allow-Origin", "*");

/// One unit of rendering work, already carrying everything it needs to
/// produce and deliver a response (an `AppHandle` for the managed
/// `SessionStore`/`TileCache`, the parsed request URI, and the responder).
type RenderJob = Box<dyn FnOnce() + Send + 'static>;

/// Sender into the single dedicated render thread. Lazily started on first
/// use so nothing here depends on being wired up in `lib.rs`'s `setup`.
fn render_queue() -> &'static Sender<RenderJob> {
    static QUEUE: OnceLock<Sender<RenderJob>> = OnceLock::new();
    QUEUE.get_or_init(|| {
        let (tx, rx) = channel::<RenderJob>();
        thread::Builder::new()
            .name("rubrica-render".into())
            .spawn(move || {
                // A panic inside one render must not kill the thread and
                // silently break every later tile — catch it, drop that one
                // response, keep serving. `render_tile`/`render_thumb`
                // themselves return `Result`, so this is insurance, not the
                // normal error path (that goes through `error_response`).
                for job in rx {
                    if catch_unwind(AssertUnwindSafe(job)).is_err() {
                        eprintln!("rubrica-render: a render job panicked; thread continues");
                    }
                }
            })
            .expect("failed to spawn the rubrica-render thread");
        tx
    })
}

fn error_response(err: RubricaError) -> Response<Vec<u8>> {
    let status = match err.code {
        RubricaErrorCode::NotFound => StatusCode::NOT_FOUND,
        RubricaErrorCode::InvalidArg => StatusCode::BAD_REQUEST,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    };
    Response::builder()
        .status(status)
        .header("Content-Type", "text/plain")
        .header(CORS_ALLOW_ANY_ORIGIN.0, CORS_ALLOW_ANY_ORIGIN.1)
        .body(err.message.into_bytes())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn png_response(bytes: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "image/png")
        .header(CORS_ALLOW_ANY_ORIGIN.0, CORS_ALLOW_ANY_ORIGIN.1)
        .body(bytes)
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn path_segments(uri: &Uri) -> Vec<&str> {
    uri.path().trim_start_matches('/').split('/').collect()
}

fn revision_from_query(uri: &Uri) -> u32 {
    uri.query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("rev=")))
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Parses a `rubrica-tile://` URL and renders the PNG (or an error response).
/// Runs on the render thread — see `handle_tile_request`.
fn tile_response(app: &AppHandle, uri: &Uri) -> Response<Vec<u8>> {
    let segments = path_segments(uri);
    let [doc_id, page, bucket, x, y] = segments[..] else {
        return error_response(RubricaError::invalid_arg(format!(
            "malformed rubrica-tile:// request path \"{}\"",
            uri.path()
        )));
    };
    let (Ok(page), Ok(bucket), Ok(x), Ok(y)) = (page.parse(), bucket.parse(), x.parse(), y.parse())
    else {
        return error_response(RubricaError::invalid_arg(format!(
            "malformed rubrica-tile:// request path \"{}\"",
            uri.path()
        )));
    };
    let revision = revision_from_query(uri);

    let sessions = app.state::<SessionStore>();
    let cache = app.state::<TileCache>();
    match tiles::render_tile(&sessions, &cache, doc_id, page, bucket, x, y, revision) {
        Ok(bytes) => png_response(bytes.to_vec()),
        Err(err) => error_response(err),
    }
}

/// Parses a `rubrica-thumb://` URL and renders the PNG (or an error
/// response). Runs on the render thread — see `handle_thumb_request`.
fn thumb_response(app: &AppHandle, uri: &Uri) -> Response<Vec<u8>> {
    let segments = path_segments(uri);
    let [doc_id, page] = segments[..] else {
        return error_response(RubricaError::invalid_arg(format!(
            "malformed rubrica-thumb:// request path \"{}\"",
            uri.path()
        )));
    };
    let Ok(page) = page.parse() else {
        return error_response(RubricaError::invalid_arg(format!(
            "malformed rubrica-thumb:// request path \"{}\"",
            uri.path()
        )));
    };

    let sessions = app.state::<SessionStore>();
    match tiles::render_thumb(&sessions, doc_id, page) {
        Ok(bytes) => png_response(bytes),
        Err(err) => error_response(err),
    }
}

/// Parses a `rubrica-print://` URL and serves the PNG `print_render` already
/// wrote for that page. Runs on the render thread — see `handle_print_request`.
///
/// Why a protocol instead of Tauri's asset protocol: `convertFileSrc(path)` with
/// no scheme is `asset://`, which is disabled unless `app.security.assetProtocol`
/// is enabled AND scoped (and needs the `protocol-asset` cargo feature) — so the
/// print preview's `<img>`s were broken-image icons. Turning that on would let
/// the webview read any file under whatever scope we list; this handler instead
/// takes NO path from the webview: the URL is `<docId>/<page>/<dpi>`, all three
/// validated, and the file is rebuilt from them under the fixed
/// `<temp>/rubrica-print/<docId>/` directory (`print_render_path`).
fn print_response(uri: &Uri) -> Response<Vec<u8>> {
    let malformed = || {
        error_response(RubricaError::invalid_arg(format!(
            "malformed rubrica-print:// request path \"{}\"",
            uri.path()
        )))
    };
    let segments = path_segments(uri);
    let [doc_id, page, dpi] = segments[..] else {
        return malformed();
    };
    // `DocId`s are `doc-<n>`; refusing anything else (separators, `..`, drive
    // letters) is what keeps the joined path inside `rubrica-print/`.
    if doc_id.is_empty()
        || !doc_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return malformed();
    }
    let (Ok(page), Ok(dpi)) = (page.parse(), dpi.parse()) else {
        return malformed();
    };
    match fs::read(print_render_path(doc_id, page, dpi)) {
        Ok(bytes) => png_response(bytes),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => error_response(
            RubricaError::not_found(format!("no rendered print page at \"{}\"", uri.path())),
        ),
        Err(err) => error_response(RubricaError::io(err.to_string())),
    }
}

/// Async entry point for `rubrica-tile://` (registered in `lib.rs`). Enqueues
/// the render onto the dedicated render thread and returns immediately, so
/// the UI thread is never blocked by PDFium/encoding — see the module doc.
pub fn handle_tile_request(
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri = request.uri().clone();
    let _ = render_queue().send(Box::new(move || {
        responder.respond(tile_response(&app, &uri));
    }));
}

/// Async entry point for `rubrica-thumb://` (registered in `lib.rs`). Same
/// render-thread hand-off as `handle_tile_request`.
pub fn handle_thumb_request(
    app: AppHandle,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let uri = request.uri().clone();
    let _ = render_queue().send(Box::new(move || {
        responder.respond(thumb_response(&app, &uri));
    }));
}

/// Async entry point for `rubrica-print://` (registered in `lib.rs`). No PDFium
/// here — `print_render` already rasterized the page to disk — but the file read
/// still goes through the render thread so a multi-megabyte PNG never blocks
/// WebView2's UI thread.
pub fn handle_print_request(request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    let uri = request.uri().clone();
    let _ = render_queue().send(Box::new(move || {
        responder.respond(print_response(&uri));
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(url: &str) -> StatusCode {
        print_response(&url.parse::<Uri>().unwrap()).status()
    }

    #[test]
    fn print_protocol_serves_the_file_print_render_wrote() {
        let path = print_render_path("doc-test-print", 2, 150);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"png-bytes").unwrap();
        let res = print_response(
            &"rubrica-print://localhost/doc-test-print/2/150"
                .parse()
                .unwrap(),
        );
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(res.body(), b"png-bytes");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn print_protocol_rejects_anything_that_could_leave_the_print_dir() {
        assert_eq!(
            status("rubrica-print://localhost/doc-never-rendered/0/150"),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status("rubrica-print://localhost/../0/150"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status("rubrica-print://localhost/doc-1%2F..%2Fx/0/150"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status("rubrica-print://localhost/C:/0/150"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status("rubrica-print://localhost/doc-1/zero/150"),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status("rubrica-print://localhost/doc-1/0"),
            StatusCode::BAD_REQUEST
        );
    }
}
