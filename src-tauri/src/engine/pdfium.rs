//! Binds to the vendored Pdfium dynamic library (see `src-tauri/pdfium/`).
//!
//! Binding happens once per process: `pdfium_render::Pdfium::new` stores the
//! bindings in a global `OnceLock` internally, so a second call to
//! [`bind`] would fail with `PdfiumLibraryBindingsAlreadyInitialized`. Callers
//! that need a `Pdfium` handle (the session manager, the pdfium smoke test)
//! should bind once at startup and share the resulting handle.

use std::path::PathBuf;
use std::sync::OnceLock;

use pdfium_render::prelude::*;

static SHARED: OnceLock<Pdfium> = OnceLock::new();

/// Returns the process-wide [`Pdfium`] handle, binding it on first call.
///
/// Every [`PdfDocument`] in every [`crate::engine::document::DocumentSession`]
/// borrows from this single `'static` reference — that sidesteps the
/// self-referential-struct problem `PdfDocument<'a>`'s lifetime would
/// otherwise create, since the handle now simply outlives the program.
/// Panics if binding fails; a Rubrica window with no working Pdfium isn't a
/// state worth limping along in.
///
/// Callers outside `lib.rs::run` (tests, anything without an `AppHandle`)
/// should use this; `run` itself calls [`shared_with`] once, first, with the
/// real resource directory, so that by the time anything else calls
/// [`shared`] the resource-dir-aware binding has already happened.
pub fn shared() -> &'static Pdfium {
    shared_with(None)
}

/// Like [`shared`], but on the *first* call also tries `resource_dir` before
/// falling back to the other candidates in [`candidate_dirs`]. Ignored on
/// every call after the first, since binding can only happen once per
/// process — see the module doc comment.
pub fn shared_with(resource_dir: Option<PathBuf>) -> &'static Pdfium {
    SHARED.get_or_init(|| bind(resource_dir).expect("failed to bind to the Pdfium library"))
}

/// `PdfPageRenderRotation` as plain degrees (0/90/180/270) — shared between
/// `engine::document` (building `DocInfo.pages`) and `engine::history`'s
/// `RotatePageCommand` so both agree on the same mapping.
pub fn rotation_to_degrees(rotation: PdfPageRenderRotation) -> i32 {
    match rotation {
        PdfPageRenderRotation::None => 0,
        PdfPageRenderRotation::Degrees90 => 90,
        PdfPageRenderRotation::Degrees180 => 180,
        PdfPageRenderRotation::Degrees270 => 270,
    }
}

/// The inverse of [`rotation_to_degrees`]; any input is normalized modulo
/// 360 first, so e.g. `-90` and `450` both mean `Degrees270`/`Degrees90`
/// as expected.
pub fn degrees_to_rotation(degrees: i32) -> PdfPageRenderRotation {
    match degrees.rem_euclid(360) {
        90 => PdfPageRenderRotation::Degrees90,
        180 => PdfPageRenderRotation::Degrees180,
        270 => PdfPageRenderRotation::Degrees270,
        _ => PdfPageRenderRotation::None,
    }
}

/// Candidate directories to look for `pdfium.dll` in, in priority order.
///
/// `resource_dir` is the production path: Tauri's resolved resource directory
/// for the running app bundle, where `bundle.resources` in `tauri.conf.json`
/// places a copy. It is `None` outside of a running Tauri app (plain
/// `cargo test`/`cargo run`).
fn candidate_dirs(resource_dir: Option<PathBuf>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    if let Some(dir) = resource_dir {
        dirs.push(dir.join("pdfium").join("bin"));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            dirs.push(exe_dir.to_path_buf());
        }
    }

    // `cargo test` binaries live in `target/<profile>/deps/`; build.rs copies
    // pdfium.dll there too, but also cover the manifest-relative path directly
    // so `cargo test` works even if the copy step above was skipped.
    dirs.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("pdfium")
            .join("bin"),
    );

    dirs
}

/// Binds to Pdfium, trying the vendored library first and falling back to a
/// system-provided one. This is the one function in the codebase that is
/// allowed to know where `pdfium.dll` lives.
pub fn bind(resource_dir: Option<PathBuf>) -> Result<Pdfium, PdfiumError> {
    let mut last_err = None;

    for dir in candidate_dirs(resource_dir) {
        let lib_path = Pdfium::pdfium_platform_library_name_at_path(&dir);
        match Pdfium::bind_to_library(&lib_path) {
            Ok(bindings) => return Ok(Pdfium::new(bindings)),
            Err(err) => last_err = Some(err),
        }
    }

    match Pdfium::bind_to_system_library() {
        Ok(bindings) => Ok(Pdfium::new(bindings)),
        Err(system_err) => Err(last_err.unwrap_or(system_err)),
    }
}
