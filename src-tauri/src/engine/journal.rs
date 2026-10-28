//! Autosave journal — CONTRACTS §8's `%LOCALAPPDATA%\Rubrica\journal\` and
//! the `recovery_available` event / `journal_recover` command. See
//! `src-tauri/API.md`'s "Autosave journal" section for the full design;
//! this module is the mechanical half of it (file format, read/write,
//! startup scan). `engine::document::DocumentSession` is what decides *when*
//! to call into this — this module has no opinion on session lifecycle.
//!
//! File format: one document per file, named `sha256(canonical path)
//! .jsonl` (hex digest, so the journal directory listing itself never
//! leaks a document's real path) under `%LOCALAPPDATA%\Rubrica\journal\`.
//! Line 1 is a JSON header (`{"path", "openedAt"}`); every following line is
//! one committed command (`{"seq", "committedAt", "command"}`). Newline-
//! delimited so a crash mid-write only ever corrupts the *last* line — see
//! [`read`], which tolerates that.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::engine::history::Command;
use crate::store::now_rfc3339;

#[derive(Debug, Serialize, Deserialize)]
struct Header {
    path: String,
    opened_at: String,
}

#[derive(Serialize, Deserialize)]
struct EntryLine {
    seq: u64,
    committed_at: String,
    command: Box<dyn Command>,
}

/// Everything [`read`] recovered from a journal file. `commands` only ever
/// contains entries that parsed successfully — a truncated or corrupt final
/// line (the expected shape of damage from a crash mid-`fsync`) is silently
/// dropped rather than failing the whole read, per this module's doc
/// comment. `last_activity_at` is the last entry's timestamp, or the
/// header's `openedAt` if the journal has no entries yet beyond the header.
pub struct JournalContents {
    pub original_path: String,
    pub commands: Vec<Box<dyn Command>>,
    pub last_activity_at: String,
}

/// A handle to one document's on-disk journal file. Cheap to construct
/// ([`for_path`]); the underlying file is only opened when a command is
/// actually appended.
pub struct Journal {
    file_path: PathBuf,
    doc_path: String,
    file: Option<File>,
    next_seq: u64,
}

/// `RUBRICA_JOURNAL_DIR`, when set, overrides the real
/// `%LOCALAPPDATA%\Rubrica\journal` location outright — this crate's own
/// tests set it (once, to a scratch directory, before touching any
/// `DocumentSession`; see `tests/engine_fixtures.rs`) so that opening
/// fixtures never reads or writes the *real* profile's journal directory.
/// Never set by production code or CONTRACTS' IPC surface.
fn journal_dir() -> Result<PathBuf, std::io::Error> {
    if let Ok(dir) = std::env::var("RUBRICA_JOURNAL_DIR") {
        return Ok(PathBuf::from(dir));
    }
    let local_appdata = std::env::var("LOCALAPPDATA")
        .map_err(|_| std::io::Error::other("LOCALAPPDATA environment variable is not set"))?;
    Ok(PathBuf::from(local_appdata).join("Rubrica").join("journal"))
}

fn hash_path(doc_path: &Path) -> String {
    let canonical = doc_path
        .canonicalize()
        .unwrap_or_else(|_| doc_path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().to_lowercase().as_bytes());
    hex_digest(&hasher.finalize())
}

fn hex_digest(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

impl Journal {
    /// Builds the handle for `doc_path`'s journal file without touching the
    /// filesystem yet (beyond resolving `%LOCALAPPDATA%`, which doesn't
    /// require the directory to exist).
    pub fn for_path(doc_path: &Path) -> Result<Self, std::io::Error> {
        let file_path = journal_dir()?.join(format!("{}.jsonl", hash_path(doc_path)));
        Ok(Self {
            file_path,
            doc_path: doc_path.to_string_lossy().into_owned(),
            file: None,
            next_seq: 0,
        })
    }

    /// The on-disk path this journal would use for `doc_path`, without
    /// constructing a full [`Journal`] — used by the startup scan, which
    /// doesn't have (or need) a live session.
    pub fn path_for(doc_path: &Path) -> Result<PathBuf, std::io::Error> {
        Ok(journal_dir()?.join(format!("{}.jsonl", hash_path(doc_path))))
    }

    pub fn exists(&self) -> bool {
        self.file_path.exists()
    }

    /// Attaches to an existing on-disk journal with `already_written_entries`
    /// entries already in it, so future [`Self::append`] calls continue
    /// numbering from there instead of restarting at 0 — used right after
    /// replaying a recovered journal (see `engine::document::DocumentSession`).
    pub fn resume(mut self, already_written_entries: usize) -> Self {
        self.next_seq = already_written_entries as u64;
        self
    }

    /// Appends one committed command and `fsync`s the file before
    /// returning, so a crash immediately after this call still has the
    /// command durably on disk. Writes the header first if this is the
    /// first append to a brand-new journal file.
    pub fn append(&mut self, command: &dyn Command) -> Result<(), std::io::Error> {
        if self.file.is_none() {
            fs::create_dir_all(
                self.file_path
                    .parent()
                    .expect("journal file path always has a parent"),
            )?;
            let is_new = !self.file_path.exists();
            let mut file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.file_path)?;
            if is_new {
                let header = Header {
                    path: self.doc_path.clone(),
                    opened_at: now_rfc3339(),
                };
                writeln!(file, "{}", serde_json::to_string(&header)?)?;
                file.sync_all()?;
            }
            self.file = Some(file);
        }

        let seq = self.next_seq;
        self.next_seq += 1;
        self.write_entry_ref(command, seq, &now_rfc3339())
    }

    fn write_entry_ref(
        &mut self,
        command: &dyn Command,
        seq: u64,
        committed_at: &str,
    ) -> Result<(), std::io::Error> {
        #[derive(Serialize)]
        struct EntryRef<'a> {
            seq: u64,
            committed_at: &'a str,
            command: &'a dyn Command,
        }
        let line = serde_json::to_string(&EntryRef {
            seq,
            committed_at,
            command,
        })?;
        let file = self.file.as_mut().expect("file opened above");
        writeln!(file, "{line}")?;
        file.sync_all()
    }

    /// Deletes the journal file, if any — called once a save durably lands
    /// or a document closes (see `API.md`: only a hard crash should ever
    /// leave a journal file behind).
    pub fn delete(&mut self) -> Result<(), std::io::Error> {
        self.file = None;
        if self.file_path.exists() {
            fs::remove_file(&self.file_path)?;
        }
        self.next_seq = 0;
        Ok(())
    }
}

/// Reads and parses a journal file at `path`, tolerating a truncated or
/// malformed final line (see the module doc comment). Returns `Ok(None)` if
/// the file doesn't exist (nothing to recover — not an error).
pub fn read(path: &Path) -> Result<Option<JournalContents>, std::io::Error> {
    if !path.exists() {
        return Ok(None);
    }
    let file = File::open(path)?;
    let mut lines = BufReader::new(file).lines();

    // A missing or malformed header means this journal is unusable (either
    // truncated before a single fsync completed, or not a journal file at
    // all) — report it as "nothing to recover" rather than guessing at a
    // path or timestamp we don't actually have.
    let Some(Ok(header_line)) = lines.next() else {
        return Ok(None);
    };
    let Ok(header) = serde_json::from_str::<Header>(&header_line) else {
        return Ok(None);
    };

    let mut commands = Vec::new();
    let mut last_activity_at = header.opened_at.clone();
    for line in lines {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<EntryLine>(&line) {
            Ok(entry) => {
                last_activity_at = entry.committed_at;
                commands.push(entry.command);
            }
            // A partially-written last line (interrupted mid-fsync) or any
            // other malformed entry is dropped, not fatal — see the module
            // doc comment. Deliberately keeps scanning rather than
            // `break`-ing, in case a future format ever needs to tolerate a
            // single bad line in the middle too.
            Err(_) => continue,
        }
    }

    Ok(Some(JournalContents {
        original_path: header.path,
        commands,
        last_activity_at,
    }))
}

/// One entry in the startup orphan scan — see [`scan_orphaned`].
pub struct OrphanedJournal {
    pub journal_id: String,
    pub path: String,
    pub saved_at: String,
}

/// Lists every journal file on disk. Called once at app startup (before any
/// session exists), so every file found is by definition orphaned — a crash
/// left it behind since nothing has had a chance to attach to it yet. Never
/// fails: a missing/unreadable journal directory just means "nothing to
/// recover", not a startup error.
pub fn scan_orphaned() -> Vec<OrphanedJournal> {
    let Ok(dir) = journal_dir() else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut found = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(Some(contents)) = read(&path) else {
            continue;
        };
        let journal_id = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        found.push(OrphanedJournal {
            journal_id,
            path: contents.original_path,
            saved_at: contents.last_activity_at,
        });
    }
    found
}
