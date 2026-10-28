//! SQLite-backed local store: recents + prefs (CONTRACTS.md §8).
//!
//! Bootstraps a `rusqlite::Connection` to `%APPDATA%\Rubrica\rubrica.db`,
//! creating the `Rubrica` directory if it doesn't exist, and runs
//! `CREATE TABLE IF NOT EXISTS` migrations for the `recents` and `prefs`
//! tables described below.
//!
//! Deliberately self-contained: this module does not depend on
//! `crate::types` or anything else in the crate, and defines no
//! `#[tauri::command]`s. That keeps it compiling and testable in complete
//! isolation from the rest of the app — the eventual `commands/app.rs`
//! wrapper is expected to call these plain functions and translate
//! `rusqlite`/[`StoreError`] failures into `crate::types::RubricaError`
//! itself.

use std::fmt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};

/// One row of the `recents` table.
///
/// Field names and types are a deliberate 1:1 mirror of
/// `crate::types::RecentDoc` (`path`, `last_opened_at`, `last_page`,
/// `last_zoom`) so the eventual wiring in `commands/app.rs` is a trivial
/// field-for-field conversion — but this is a distinct type. `store` never
/// imports `crate::types`, on purpose, to stay dependency-free of the rest
/// of the crate.
#[derive(Debug, Clone, PartialEq)]
pub struct RecentRow {
    pub path: String,
    pub last_opened_at: String,
    pub last_page: u32,
    pub last_zoom: f64,
}

/// A handle to the local SQLite store.
///
/// Construct with [`Store::open`] in production code. Tests (and any other
/// caller that wants an isolated database) should use [`Store::open_at`]
/// directly against an explicit path, e.g. a `tempfile::tempdir()` — that
/// path is exactly how this module's own unit tests avoid ever touching the
/// real `%APPDATA%\Rubrica\rubrica.db` on the development machine.
pub struct Store {
    conn: Connection,
}

impl Store {
    /// Opens (creating if necessary) the real store at
    /// `%APPDATA%\Rubrica\rubrica.db`, running migrations.
    ///
    /// `RUBRICA_APPDATA_DIR`, when set, overrides `%APPDATA%\Rubrica` outright
    /// — mirroring `engine::journal`'s `RUBRICA_JOURNAL_DIR` — so the e2e
    /// suite can point a real, non-mock app launch at an isolated scratch
    /// directory instead of a developer machine's actual recents/prefs.
    /// Never set by production code or CONTRACTS' IPC surface.
    pub fn open() -> Result<Self, StoreError> {
        let db_path = if let Ok(dir) = std::env::var("RUBRICA_APPDATA_DIR") {
            PathBuf::from(dir).join("rubrica.db")
        } else {
            let appdata = std::env::var("APPDATA").map_err(|_| StoreError::MissingAppData)?;
            PathBuf::from(appdata).join("Rubrica").join("rubrica.db")
        };
        Self::open_at(&db_path)
    }

    /// Opens (creating if necessary) a store at an explicit path, creating
    /// its parent directory and running migrations. Production code should
    /// prefer [`Store::open`]; this exists so it (and tests) can be pointed
    /// at any path.
    pub fn open_at(db_path: &Path) -> Result<Self, StoreError> {
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(db_path)?;
        Self::migrate(&conn)?;
        Ok(Self { conn })
    }

    fn migrate(conn: &Connection) -> rusqlite::Result<()> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS recents (
                path            TEXT PRIMARY KEY,
                last_opened_at  TEXT NOT NULL,
                last_page       INTEGER NOT NULL,
                last_zoom       REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS prefs (
                key         TEXT PRIMARY KEY,
                value_json  TEXT NOT NULL
            );",
        )
    }

    /// Returns the raw `value_json` string for `key`, or `None` if it has
    /// never been set. Parsing/typing that JSON is the caller's concern.
    pub fn prefs_get(&self, key: &str) -> rusqlite::Result<Option<String>> {
        self.conn
            .query_row(
                "SELECT value_json FROM prefs WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
    }

    /// Upserts `key` -> `value_json`.
    pub fn prefs_set(&self, key: &str, value_json: &str) -> rusqlite::Result<()> {
        self.conn.execute(
            "INSERT INTO prefs (key, value_json) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json",
            params![key, value_json],
        )?;
        Ok(())
    }

    /// All recents, most-recently-opened first.
    pub fn recents_list(&self) -> rusqlite::Result<Vec<RecentRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT path, last_opened_at, last_page, last_zoom
             FROM recents ORDER BY last_opened_at DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(RecentRow {
                path: row.get(0)?,
                last_opened_at: row.get(1)?,
                last_page: row.get(2)?,
                last_zoom: row.get(3)?,
            })
        })?;
        rows.collect()
    }

    /// Upserts a recent-document entry, stamping `last_opened_at` with the
    /// current time (UTC, RFC-3339-ish with millisecond precision).
    ///
    /// Not an IPC command per CONTRACTS §3, but `recents_list` needs *some*
    /// write path for it to ever return real data — this is here as a plain
    /// function for whoever wires up the real `doc_open` flow later.
    pub fn recents_upsert(
        &self,
        path: &str,
        last_page: u32,
        last_zoom: f64,
    ) -> rusqlite::Result<()> {
        let now = now_rfc3339();
        self.conn.execute(
            "INSERT INTO recents (path, last_opened_at, last_page, last_zoom)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(path) DO UPDATE SET
                last_opened_at = excluded.last_opened_at,
                last_page = excluded.last_page,
                last_zoom = excluded.last_zoom",
            params![path, now, last_page, last_zoom],
        )?;
        Ok(())
    }

    /// Deletes every row in `recents`.
    pub fn recents_clear(&self) -> rusqlite::Result<()> {
        self.conn.execute("DELETE FROM recents", [])?;
        Ok(())
    }
}

/// Errors from [`Store::open`]/[`Store::open_at`].
///
/// Every other `Store` method returns a plain `rusqlite::Result` — this
/// wrapper only exists to describe the one extra failure mode (`APPDATA`
/// missing, or its directory not creatable) that opening the store can hit
/// before rusqlite is even involved. Trivial for a caller to fold into
/// `crate::types::RubricaError` (e.g. `Io` for all three variants).
#[derive(Debug)]
pub enum StoreError {
    /// The `APPDATA` environment variable was not set.
    MissingAppData,
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::MissingAppData => write!(f, "APPDATA environment variable is not set"),
            StoreError::Io(e) => write!(f, "I/O error opening store: {e}"),
            StoreError::Sqlite(e) => write!(f, "sqlite error opening store: {e}"),
        }
    }
}

impl std::error::Error for StoreError {}

impl From<std::io::Error> for StoreError {
    fn from(e: std::io::Error) -> Self {
        StoreError::Io(e)
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sqlite(e)
    }
}

/// Current UTC time as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
///
/// Hand-rolled from `SystemTime` (millisecond precision, valid RFC 3339)
/// rather than adding a `time`/`chrono` dependency — good enough for a
/// "last opened" timestamp; swapping in a real date/time crate later is a
/// one-function change if a caller ever needs more (timezones, etc.).
/// `pub(crate)` so `engine::journal` can stamp its own entries with the same
/// format without duplicating this — the "self-contained" design note above
/// is about this module not depending on the rest of the crate, not about
/// nothing else being allowed to depend on it.
pub(crate) fn now_rfc3339() -> String {
    let since_epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format_unix_timestamp(since_epoch.as_secs(), since_epoch.subsec_millis())
}

fn format_unix_timestamp(total_secs: u64, millis: u32) -> String {
    let days = (total_secs / 86_400) as i64;
    let secs_of_day = total_secs % 86_400;
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;

    let (year, month, day) = civil_from_days(days);

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

/// Converts a day count since the Unix epoch (1970-01-01) into a
/// `(year, month, day)` civil (Gregorian) date. Public-domain algorithm by
/// Howard Hinnant: <http://howardhinnant.github.io/date_algorithms.html#civil_from_days>
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Opens a fresh store backed by a temp directory. The `TempDir` guard
    /// must stay alive for as long as the store is used, hence returning
    /// both — dropping it deletes the directory.
    fn open_test_store() -> (tempfile::TempDir, Store) {
        let dir = tempdir().expect("tempdir");
        let db_path = dir.path().join("rubrica.db");
        let store = Store::open_at(&db_path).expect("open_at should succeed");
        (dir, store)
    }

    #[test]
    fn migrations_create_both_tables_on_a_fresh_file() {
        let (_dir, store) = open_test_store();
        // Both tables should exist and be queryable without error, empty.
        assert_eq!(store.recents_list().unwrap(), vec![]);
        assert_eq!(store.prefs_get("anything").unwrap(), None);
    }

    #[test]
    fn prefs_round_trip() {
        let (_dir, store) = open_test_store();
        store.prefs_set("theme", "\"dark\"").unwrap();
        assert_eq!(
            store.prefs_get("theme").unwrap(),
            Some("\"dark\"".to_string())
        );

        // Setting the same key again upserts rather than duplicating.
        store.prefs_set("theme", "\"light\"").unwrap();
        assert_eq!(
            store.prefs_get("theme").unwrap(),
            Some("\"light\"".to_string())
        );
    }

    #[test]
    fn prefs_get_on_missing_key_returns_none() {
        let (_dir, store) = open_test_store();
        assert_eq!(store.prefs_get("does-not-exist").unwrap(), None);
    }

    #[test]
    fn recents_upsert_and_list_orders_most_recent_first() {
        let (_dir, store) = open_test_store();
        store.recents_upsert("C:/docs/a.pdf", 1, 1.0).unwrap();
        // A short sleep guarantees a strictly later millisecond-precision
        // timestamp for the second row, so ordering is unambiguous.
        std::thread::sleep(std::time::Duration::from_millis(5));
        store.recents_upsert("C:/docs/b.pdf", 5, 2.5).unwrap();

        let recents = store.recents_list().unwrap();
        assert_eq!(recents.len(), 2);
        assert_eq!(recents[0].path, "C:/docs/b.pdf");
        assert_eq!(recents[0].last_page, 5);
        assert_eq!(recents[0].last_zoom, 2.5);
        assert_eq!(recents[1].path, "C:/docs/a.pdf");
    }

    #[test]
    fn recents_upsert_same_path_updates_in_place() {
        let (_dir, store) = open_test_store();
        store.recents_upsert("C:/docs/a.pdf", 1, 1.0).unwrap();
        store.recents_upsert("C:/docs/a.pdf", 9, 3.0).unwrap();

        let recents = store.recents_list().unwrap();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].last_page, 9);
        assert_eq!(recents[0].last_zoom, 3.0);
    }

    #[test]
    fn recents_clear_empties_the_table() {
        let (_dir, store) = open_test_store();
        store.recents_upsert("C:/docs/a.pdf", 1, 1.0).unwrap();
        store.recents_upsert("C:/docs/b.pdf", 1, 1.0).unwrap();
        assert_eq!(store.recents_list().unwrap().len(), 2);

        store.recents_clear().unwrap();
        assert_eq!(store.recents_list().unwrap(), vec![]);
    }

    #[test]
    fn open_at_creates_missing_parent_directories() {
        let dir = tempdir().expect("tempdir");
        let nested = dir.path().join("does").join("not").join("exist-yet");
        let db_path = nested.join("rubrica.db");
        assert!(!nested.exists());

        let _store = Store::open_at(&db_path).expect("open_at should create parent dirs");
        assert!(db_path.exists());
    }
}
