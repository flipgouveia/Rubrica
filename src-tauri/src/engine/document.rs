//! The real `DocumentSession` — CONTRACTS §3's `document` domain, backing
//! `commands/document.rs`. See `src-tauri/API.md` for the full design.

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::thread;

use pdfium_render::prelude::*;

use crate::engine::history::{Command, CommandStack};
use crate::engine::journal::{self, Journal};
use crate::engine::pdfium;
use crate::engine::search::SearchCache;
use crate::types::{CmdResult, DocId, DocInfo, MutationResult, PageSize, RubricaError};

/// One open document. Owns the PDFium document handle, the undo/redo
/// command stack, and the autosave journal for its own file. Never `Clone`
/// — there is exactly one of these per open `DocId`, held inside
/// [`SessionStore`].
pub struct DocumentSession {
    id: DocId,
    path: PathBuf,
    document: PdfDocument<'static>,
    revision: u32,
    encrypted: bool,
    has_form: bool,
    commands: CommandStack,
    journal: Journal,
    /// Search v2 page indexes + header/footer detection; invalidated by every
    /// mutation/undo/redo and dropped with the session (`doc_close`).
    search_cache: SearchCache,
}

/// A unit of work for the PDFium owner thread: exclusive access to the whole
/// open-document registry. Type-erased and boxed; the concrete return value
/// travels back over a per-call reply channel the closure captures.
type StoreJob = Box<dyn FnOnce(&mut HashMap<DocId, DocumentSession>) + Send>;

/// `.manage()`d once in `lib.rs`. **The single owner of every `PdfDocument`
/// in the process, and the only thread that ever calls PDFium.**
///
/// PDFium here is not merely non-reentrant: the vendored build
/// corrupts/segfaults when touched from more than one OS thread even if every
/// call is serialized behind a `Mutex` (see `agents/reports/r2-report.md` /
/// `src-tauri/API.md` — it is thread-*identity* sensitive, not just
/// concurrency-sensitive). A `Mutex` gives mutual exclusion but not a single
/// thread identity, so this is an actor instead: one long-lived
/// `rubrica-pdfium` thread owns the `HashMap<DocId, DocumentSession>` and runs
/// EVERY operation on it — `doc_open` (which creates a `PdfDocument`), tile
/// and thumbnail rasterization, text extraction/search, mutations, saves, and
/// the eventual drop of each `PdfDocument` (`FPDF_CloseDocument` on close /
/// shutdown) — through [`SessionStore::with_store`] / [`with_session`]. Nothing
/// else ever holds a `PdfDocument`, so PDFium only ever runs on that one
/// thread, regardless of which Tauri command thread (tokio pool) or the
/// `rubrica-render` thread asked for the work.
///
/// Callers block on a reply channel while the owner thread works. **A closure
/// passed to `with_store`/`with_session` must never itself call back into the
/// store** — the owner thread is busy running it and could not service the
/// re-entrant request, so that would deadlock it against itself.
pub struct SessionStore {
    tx: Sender<StoreJob>,
}

impl Default for SessionStore {
    fn default() -> Self {
        let (tx, rx) = channel::<StoreJob>();
        thread::Builder::new()
            .name("rubrica-pdfium".into())
            .spawn(move || {
                let mut sessions: HashMap<DocId, DocumentSession> = HashMap::new();
                for job in rx {
                    // One operation panicking must not take the owner thread
                    // down (that would strand every open document and every
                    // future request). Catch it here; the caller observes the
                    // dropped reply channel as an internal error. A panic
                    // cannot poison anything — the registry is plain data
                    // owned by this thread, not shared behind a lock.
                    let _ = catch_unwind(AssertUnwindSafe(|| job(&mut sessions)));
                }
                // Sender dropped (app shutting down): dropping `sessions` here
                // runs every remaining `FPDF_CloseDocument` on this same
                // thread, never a foreign one.
            })
            .expect("failed to spawn the rubrica-pdfium owner thread");
        SessionStore { tx }
    }
}

impl SessionStore {
    /// Runs `f` on the PDFium owner thread with exclusive access to the whole
    /// registry, blocking the caller until it returns. Use it for
    /// open/close/list and anything spanning documents; [`with_session`] is
    /// the common per-document case. `Err` only if the owner thread is gone
    /// (its channel closed, or a job aborted the process) — a normal panic
    /// inside `f` is caught by the owner loop and surfaces here as that error.
    pub fn with_store<R: Send + 'static>(
        &self,
        f: impl FnOnce(&mut HashMap<DocId, DocumentSession>) -> R + Send + 'static,
    ) -> CmdResult<R> {
        let (reply_tx, reply_rx) = channel::<R>();
        self.tx
            .send(Box::new(move |sessions| {
                let _ = reply_tx.send(f(sessions));
            }))
            .map_err(|_| RubricaError::internal("the PDFium owner thread is gone"))?;
        reply_rx
            .recv()
            .map_err(|_| RubricaError::internal("the PDFium owner thread dropped a reply"))
    }

    /// Runs `f` on the owner thread with exclusive access to one open
    /// document. `Err` is `NotFound` when no document has that id, or the
    /// internal error [`with_store`] can return.
    pub fn with_session<R: Send + 'static>(
        &self,
        doc_id: &str,
        f: impl FnOnce(&mut DocumentSession) -> R + Send + 'static,
    ) -> CmdResult<R> {
        let doc_id = doc_id.to_string();
        self.with_store(move |sessions| match sessions.get_mut(&doc_id) {
            Some(session) => Ok(f(session)),
            None => Err(RubricaError::not_found(format!(
                "no open document with id \"{doc_id}\""
            ))),
        })?
    }
}

static NEXT_DOC_ID: AtomicU64 = AtomicU64::new(1);

fn next_doc_id() -> DocId {
    format!("doc-{}", NEXT_DOC_ID.fetch_add(1, Ordering::Relaxed))
}

fn map_open_error(err: PdfiumError) -> RubricaError {
    match err {
        PdfiumError::PdfiumLibraryInternalError(
            PdfiumInternalError::PasswordError | PdfiumInternalError::SecurityError,
        ) => RubricaError::encrypted("this document is password-protected"),
        PdfiumError::PdfiumLibraryInternalError(PdfiumInternalError::FormatError) => {
            RubricaError::corrupt("this document could not be parsed")
        }
        PdfiumError::IoError(io_err) => RubricaError::io(io_err.to_string()),
        other => RubricaError::corrupt(other.to_string()),
    }
}

/// `FPDF_GetPageWidthF`/`HeightF` (what `page.width()`/`.height()` call)
/// already account for the page's `/Rotate` entry — confirmed in the
/// vendored bindgen doc comment ("changing the rotation of the page affects
/// the return value") — so, unlike the mock's `getDocInfo`, there is no
/// separate swap-on-90/270 step to apply here: these two values are already
/// the "as displayed" size.
fn page_size_to_dto(page: &PdfPage) -> PageSize {
    PageSize {
        width: page.width().value as f64,
        height: page.height().value as f64,
    }
}

impl DocumentSession {
    /// Opens `path`. Classifies a PDFium load failure into `ENCRYPTED` /
    /// `CORRUPT` / `IO` (see [`map_open_error`]) — v1 never collects a
    /// password (CONTRACTS' `doc_open` takes only a path), so a
    /// user-password-protected file always surfaces as `ENCRYPTED` here,
    /// never a successful open.
    ///
    /// If an autosave journal exists for this path (a previous process
    /// crashed before saving or closing), replays it onto the freshly
    /// loaded document before returning — see `API.md`'s "Autosave
    /// journal" section.
    pub fn open(path_str: &str) -> CmdResult<Self> {
        let path = PathBuf::from(path_str);
        let document = pdfium::shared()
            .load_pdf_from_file(&path, None)
            .map_err(map_open_error)?;

        let has_form = document.form().is_some();
        // `security_handler_revision()` returns `Ok(Unprotected)` for a
        // perfectly ordinary, unencrypted document — `Unprotected` is a
        // real, non-error variant (confirmed in the vendored crate source),
        // not a sentinel for "no security handler is an error here". Only
        // an actual `Revision2/3/4` answer means "this document has a
        // security handler", regardless of whether it opened without a
        // password (see API.md: an owner-password-only PDF opens fine but
        // should still report `encrypted: true`).
        let encrypted = !matches!(
            document.permissions().security_handler_revision(),
            Ok(PdfSecurityHandlerRevision::Unprotected)
        );
        let journal = Journal::for_path(&path).map_err(|e| RubricaError::io(e.to_string()))?;

        let mut session = Self {
            id: next_doc_id(),
            path,
            document,
            revision: 0,
            encrypted,
            has_form,
            commands: CommandStack::new(),
            journal,
            search_cache: SearchCache::default(),
        };
        session.replay_journal();
        Ok(session)
    }

    /// Best-effort: replays a matching on-disk journal (if any) onto
    /// `self.document`, leaving `self.commands`/`self.revision`/
    /// `self.journal` reflecting whatever was successfully replayed. Never
    /// fails the open — a missing, corrupt, or unreadable journal is simply
    /// "nothing to recover" (see `engine::journal::read`'s own tolerance for
    /// a damaged final line).
    fn replay_journal(&mut self) {
        let Ok(journal_path) = Journal::path_for(&self.path) else {
            return;
        };
        let Ok(Some(contents)) = journal::read(&journal_path) else {
            return;
        };

        let mut replayed = 0usize;
        for command in contents.commands {
            if self.commands.commit(&mut self.document, command).is_ok() {
                replayed += 1;
                self.revision += 1;
            }
        }

        if replayed > 0 {
            if let Ok(journal) = Journal::for_path(&self.path) {
                self.journal = journal.resume(replayed);
            }
        }
    }

    pub fn id(&self) -> &DocId {
        &self.id
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn document(&self) -> &PdfDocument<'static> {
        &self.document
    }

    pub fn revision(&self) -> u32 {
        self.revision
    }

    pub fn dirty(&self) -> bool {
        self.commands.dirty()
    }

    pub fn can_undo(&self) -> bool {
        self.commands.can_undo()
    }

    pub fn can_redo(&self) -> bool {
        self.commands.can_redo()
    }

    /// The CONTRACTS §2 `DocInfo` projection of this session's current
    /// state. See [`page_size_to_dto`] for why page sizes need no
    /// rotation-swap step here, unlike `mock/state.ts::getDocInfo`.
    pub fn info(&self) -> DocInfo {
        let pages_collection = self.document.pages();
        let mut pages = Vec::with_capacity(pages_collection.len() as usize);
        for page in pages_collection.iter() {
            pages.push(page_size_to_dto(&page));
        }
        DocInfo {
            doc_id: self.id.clone(),
            path: self.path.to_string_lossy().into_owned(),
            page_count: pages.len() as u32,
            pages,
            encrypted: self.encrypted,
            dirty: self.dirty(),
            revision: self.revision,
            has_form: self.has_form,
        }
    }

    /// The **only** way wave-2 code should mutate this session's document.
    /// Applies `command`, journals it (so a crash immediately after this
    /// call still recovers it — see `engine::journal`), and bumps
    /// `revision`. Does *not* invalidate the tile cache or emit
    /// `doc_state_changed` — the caller (a `#[tauri::command]` handler with
    /// access to Tauri state) does both with the returned invalidated pages,
    /// the same pattern `commands/history.rs` uses for undo/redo.
    pub fn search_cache(&self) -> &SearchCache {
        &self.search_cache
    }

    pub fn search_cache_mut(&mut self) -> &mut SearchCache {
        &mut self.search_cache
    }

    /// Drops search indexes made stale by a change to `pages`. A change in
    /// page count shifts every later page's index, so it clears everything.
    fn invalidate_search(&mut self, pages: &[u32], page_count_before: PdfPageIndex) {
        if self.document.pages().len() != page_count_before {
            self.search_cache.clear();
        } else {
            self.search_cache.invalidate(pages);
        }
    }

    pub fn commit(&mut self, command: Box<dyn Command>) -> CmdResult<MutationResult> {
        let count_before = self.document.pages().len();
        let pages = self.commands.commit(&mut self.document, command)?;
        self.invalidate_search(&pages, count_before);
        if let Some(last) = self.commands.peek_undo() {
            self.journal
                .append(last)
                .map_err(|e| RubricaError::io(e.to_string()))?;
        }
        self.revision += 1;
        Ok(MutationResult {
            revision: self.revision,
            invalidated_pages: pages,
        })
    }

    /// `Ok(None)` means there was nothing to undo — see
    /// `engine::history::CommandStack::undo`. Undo/redo are not journaled
    /// (a documented limitation, not an oversight — see `API.md`): a crash
    /// mid-undo-session recovers to the state as if every originally
    /// committed command were still applied, not to the exact undo/redo
    /// position the user was at.
    pub fn undo(&mut self) -> CmdResult<Option<MutationResult>> {
        let count_before = self.document.pages().len();
        let pages = self.commands.undo(&mut self.document)?;
        if let Some(pages) = &pages {
            self.invalidate_search(pages, count_before);
        }
        Ok(pages.map(|pages| {
            self.revision += 1;
            MutationResult {
                revision: self.revision,
                invalidated_pages: pages,
            }
        }))
    }

    pub fn redo(&mut self) -> CmdResult<Option<MutationResult>> {
        let count_before = self.document.pages().len();
        let pages = self.commands.redo(&mut self.document)?;
        if let Some(pages) = &pages {
            self.invalidate_search(pages, count_before);
        }
        Ok(pages.map(|pages| {
            self.revision += 1;
            MutationResult {
                revision: self.revision,
                invalidated_pages: pages,
            }
        }))
    }

    /// Saves in place. See `API.md`'s "Atomic save" section for the exact
    /// write/backup/rename sequence.
    pub fn save(&mut self, make_backup: bool) -> CmdResult<()> {
        let target = self.path.clone();
        write_atomically(&self.document, &target, make_backup)?;
        self.journal
            .delete()
            .map_err(|e| RubricaError::io(e.to_string()))?;
        self.commands.mark_saved();
        Ok(())
    }

    /// Saves to a new path and adopts it as this session's path going
    /// forward. Any journal for the *old* path is discarded (a completed
    /// save means there's nothing left to recover there); a fresh journal
    /// for the new path starts empty, since saving is itself the "clean"
    /// state.
    pub fn save_as(&mut self, new_path: &str, make_backup: bool) -> CmdResult<()> {
        let target = PathBuf::from(new_path);
        write_atomically(&self.document, &target, make_backup)?;
        self.journal
            .delete()
            .map_err(|e| RubricaError::io(e.to_string()))?;
        self.path = target.clone();
        self.journal = Journal::for_path(&target).map_err(|e| RubricaError::io(e.to_string()))?;
        self.commands.mark_saved();
        Ok(())
    }

    /// Deletes this session's journal file. Called by `doc_close`
    /// unconditionally (see `API.md`: a deliberate close, dirty or not, is a
    /// discard, and dropping `self.document` afterwards already discards
    /// any unsaved in-memory edits, since the next `open` reloads fresh
    /// bytes from disk).
    pub fn forget_journal(&mut self) {
        let _ = self.journal.delete();
    }
}

static SAVE_TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// `bytes` -> temp file (same directory as `target`, fsynced) -> optional
/// `.bak` rotation -> atomic rename onto `target`. See `API.md`'s "Atomic
/// save" section for the reasoning behind this exact ordering.
fn write_atomically(
    document: &PdfDocument<'static>,
    target: &Path,
    make_backup: bool,
) -> CmdResult<()> {
    let bytes = document
        .save_to_bytes()
        .map_err(|e| RubricaError::internal(e.to_string()))?;

    let dir = target
        .parent()
        .ok_or_else(|| RubricaError::invalid_arg("save target path has no parent directory"))?;
    fs::create_dir_all(dir).map_err(|e| RubricaError::io(e.to_string()))?;

    let counter = SAVE_TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_path = dir.join(format!(".rubrica-tmp-{}-{counter}", std::process::id()));

    {
        let mut tmp_file = File::create(&tmp_path).map_err(|e| RubricaError::io(e.to_string()))?;
        tmp_file
            .write_all(&bytes)
            .map_err(|e| RubricaError::io(e.to_string()))?;
        tmp_file
            .sync_all()
            .map_err(|e| RubricaError::io(e.to_string()))?;
    }

    if make_backup && target.exists() {
        let bak_path = backup_path(target);
        let _ = fs::remove_file(&bak_path); // Windows rename fails onto an existing file.
        if let Err(e) = fs::rename(target, &bak_path) {
            let _ = fs::remove_file(&tmp_path);
            return Err(RubricaError::io(e.to_string()));
        }
    }

    if let Err(e) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(RubricaError::io(e.to_string()));
    }

    Ok(())
}

fn backup_path(target: &Path) -> PathBuf {
    let mut name = target.file_name().unwrap_or_default().to_os_string();
    name.push(".bak");
    target.with_file_name(name)
}
