//! R7 (Windows citizenship): OS-integration hooks that are *not* part of
//! CONTRACTS' IPC surface — single-instance file-open routing, the taskbar
//! Jump List, and the process-wide Explicit AppUserModelID. Everything here
//! is packaging/OS glue; it never touches document state and only reads the
//! existing SQLite `recents` table (already `.manage()`d by `lib.rs`) that
//! `commands::app` already owns.
//!
//! Per `agents/R7-windows-citizenship.md`: this is the one file wave-2 OS
//! integration is allowed to add to `src-tauri`. `lib.rs`/`main.rs` still
//! need a handful of one-line call-outs into here (plugin registration,
//! the portable-mode env redirect) — those are recorded in the R7 report
//! rather than silently expanding this file's own footprint.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};
use windows::core::{Interface, Result as WinResult, HSTRING, PROPVARIANT};
use windows::Win32::Storage::EnhancedStorage::PKEY_Title;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::Common::{IObjectArray, IObjectCollection};
use windows::Win32::UI::Shell::PropertiesSystem::IPropertyStore;
use windows::Win32::UI::Shell::{
    DestinationList, EnumerableObjectCollection, ICustomDestinationList, IShellLinkW,
    SetCurrentProcessExplicitAppUserModelID, ShellLink,
};

use crate::store::Store;

/// Ad hoc Tauri event carrying a file path to open into a new tab. Not part
/// of CONTRACTS §4 (that surface is frozen and tauri-specta-generated) —
/// this is hand-rolled, OS-integration-only wiring. `src/chrome/
/// fileOpenEvents.ts` is the one frontend file that listens for it (see the
/// R7 report for why that one small `src/**` touchpoint was necessary).
pub const OPEN_FILE_EVENT: &str = "rubrica://open-file";
/// Emitted once by the frontend on mount, after it has attached its
/// `OPEN_FILE_EVENT` listener — flushes whatever path the process was
/// launched with (cold-start file association) without racing the
/// listener's own registration.
const FRONTEND_READY_EVENT: &str = "rubrica://frontend-ready";
/// Jump List "New window" task and its command-line marker.
const NEW_WINDOW_ARG: &str = "--new-window";
/// Set by `main.rs` on the process environment (never by CONTRACTS' IPC
/// surface) when the portable marker file next to the exe was found.
const PORTABLE_ENV_VAR: &str = "RUBRICA_PORTABLE";
const JUMP_LIST_MAX_RECENTS: usize = 10;

/// Whether this run is the portable build (see `main.rs`). Read once by
/// `lib.rs` to skip registering the updater plugin — deliverable 4's
/// "disabled cleanly in the portable build".
pub fn is_portable() -> bool {
    std::env::var(PORTABLE_ENV_VAR).is_ok()
}

/// A file path pulled from argv, still waiting for the frontend to be ready
/// to receive it. `.manage()`d once in `lib.rs` before `.run()`.
pub struct PendingOpen(Mutex<Option<String>>);

/// What an argv list (cold-start `std::env::args()`, or a relaunch attempt
/// forwarded by the single-instance plugin — both are `[exe_path, ...]`,
/// see that plugin's Windows implementation) asked Rubrica to do.
enum LaunchIntent {
    /// Nothing to act on — a plain launch/relaunch.
    None,
    /// The Jump List's "New window" task.
    NewWindow,
    /// A file to open (double-click file association, or a dropped path).
    OpenFile(String),
}

fn launch_intent(args: impl IntoIterator<Item = String>, cwd: &Path) -> LaunchIntent {
    let Some(arg) = args.into_iter().nth(1) else {
        return LaunchIntent::None;
    };
    if arg == NEW_WINDOW_ARG {
        return LaunchIntent::NewWindow;
    }
    let path = PathBuf::from(&arg);
    let resolved = if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    };
    LaunchIntent::OpenFile(resolved.to_string_lossy().into_owned())
}

/// Registers the OS-integration bits that need a live `AppHandle`/window:
/// the frontend-ready handshake (delivers a cold-start file-open path) and
/// the Jump List refresh (once now, and again after every document event).
/// Single-instance itself is registered on the `Builder` directly in
/// `lib.rs` (must be the first plugin registered) — see that file.
pub fn init(app: &tauri::App) {
    set_app_user_model_id();

    let handle = app.handle().clone();
    app.listen(FRONTEND_READY_EVENT, move |_event| {
        if let Some(pending) = handle.state::<PendingOpen>().0.lock().unwrap().take() {
            let _ = handle.emit(OPEN_FILE_EVENT, pending);
        }
    });

    let handle = app.handle().clone();
    app.listen("doc_state_changed", move |_event| {
        refresh_jump_list(&handle);
    });

    refresh_jump_list(app.handle());
}

/// The single-instance plugin's callback (registered first, per its own
/// docs, directly on the `Builder` in `lib.rs`). Focuses the running
/// window and routes a relaunch's argv the same way cold-start argv is
/// routed — see `launch_intent`.
pub fn handle_relaunch(app: &AppHandle, args: Vec<String>, cwd: String) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    match launch_intent(args, Path::new(&cwd)) {
        LaunchIntent::None => {}
        LaunchIntent::NewWindow => open_new_window(app),
        LaunchIntent::OpenFile(path) => {
            let _ = app.emit(OPEN_FILE_EVENT, path);
        }
    }
}

/// Computes what `lib.rs` should `.manage()` as `PendingOpen` from this
/// process's own cold-start argv, before the window/frontend exist yet.
pub fn pending_open_from_cold_start() -> PendingOpen {
    let cwd = std::env::current_dir().unwrap_or_default();
    let pending = match launch_intent(std::env::args(), &cwd) {
        LaunchIntent::OpenFile(path) => Some(path),
        LaunchIntent::None | LaunchIntent::NewWindow => None,
    };
    PendingOpen(Mutex::new(pending))
}

/// The Jump List's "New window" task, and a relaunch carrying
/// `--new-window`: opens a second, fully independent app window (its own
/// webview, its own in-memory frontend state) rather than a tab in the
/// existing one — CONTRACTS/TOOL-API's tab model is unaffected, this is a
/// second top-level window running the same SPA fresh.
fn open_new_window(app: &AppHandle) {
    let label = format!(
        "w{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    );
    if let Err(err) = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title("Rubrica")
        .inner_size(1200.0, 800.0)
        .min_inner_size(800.0, 600.0)
        .build()
    {
        eprintln!("rubrica: failed to open a new window: {err}");
    }
}

/// Sets the process's Explicit AppUserModelID so the taskbar groups this
/// unpackaged exe's windows/jump-list/notifications under one stable
/// identity. Best-effort: a failure here (already set by a caller further
/// up, running under a shell that denies it, ...) is not fatal.
fn set_app_user_model_id() {
    unsafe {
        let _ = SetCurrentProcessExplicitAppUserModelID(&HSTRING::from("Rubrica.Rubrica"));
    }
}

/// Rebuilds the taskbar Jump List's "Recent" category from the SQLite
/// `recents` table plus a static "New window" task. Best-effort: the Jump
/// List is a nice-to-have, so any COM failure is logged and swallowed
/// rather than surfaced anywhere — never let a taskbar quirk take down the
/// app. Runs on whatever thread called it (COM is initialized and torn
/// down within this one call, since that thread's identity isn't ours to
/// assume — see the R7 report on why events, not a dedicated thread, drive
/// this).
fn refresh_jump_list(app: &AppHandle) {
    let Ok(exe_path) = std::env::current_exe() else {
        return;
    };
    let recents: Vec<String> = {
        let store = app.state::<Mutex<Store>>();
        let Ok(store) = store.lock() else { return };
        match store.recents_list() {
            Ok(rows) => rows.into_iter().map(|r| r.path).collect(),
            Err(err) => {
                eprintln!("rubrica: could not read recents for the jump list: {err}");
                return;
            }
        }
    };

    if let Err(err) = build_jump_list(&exe_path, &recents) {
        eprintln!("rubrica: failed to update the taskbar jump list: {err}");
    }
}

/// RAII guard pairing every successful `CoInitializeEx` (including the
/// `S_FALSE` "already initialized on this thread" case — Microsoft's own
/// docs require a matching `CoUninitialize` either way) with exactly one
/// `CoUninitialize`, even across an early `?` return.
struct ComScope(bool);

impl ComScope {
    fn enter() -> Self {
        let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
        Self(hr.is_ok())
    }
}

impl Drop for ComScope {
    fn drop(&mut self) {
        if self.0 {
            unsafe { CoUninitialize() };
        }
    }
}

fn build_jump_list(exe_path: &Path, recents: &[String]) -> WinResult<()> {
    let _com = ComScope::enter();

    let dest_list: ICustomDestinationList =
        unsafe { CoCreateInstance(&DestinationList, None, CLSCTX_INPROC_SERVER) }?;
    let mut min_slots: u32 = 0;
    let _removed: IObjectArray = unsafe { dest_list.BeginList(&mut min_slots) }?;

    let recent_collection: IObjectCollection =
        unsafe { CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER) }?;
    for path in recents.iter().take(JUMP_LIST_MAX_RECENTS) {
        let title = Path::new(path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        let link = shell_link(exe_path, &format!("\"{path}\""), &title)?;
        unsafe { recent_collection.AddObject(&link) }?;
    }
    let recent_array: IObjectArray = recent_collection.cast()?;
    unsafe { dest_list.AppendCategory(&HSTRING::from("Recent"), &recent_array) }?;

    let tasks: IObjectCollection =
        unsafe { CoCreateInstance(&EnumerableObjectCollection, None, CLSCTX_INPROC_SERVER) }?;
    let new_window = shell_link(exe_path, NEW_WINDOW_ARG, "New window")?;
    unsafe { tasks.AddObject(&new_window) }?;
    let tasks_array: IObjectArray = tasks.cast()?;
    unsafe { dest_list.AddUserTasks(&tasks_array) }?;

    unsafe { dest_list.CommitList() }
}

/// Builds one in-memory `IShellLinkW` (never saved to a `.lnk` file — Jump
/// List categories/tasks take the shell link objects directly) targeting
/// `exe_path` with `args`, titled `title` via `PKEY_Title` (the property
/// Explorer actually reads for a Jump List item's label — `SetDescription`
/// alone is not enough).
fn shell_link(exe_path: &Path, args: &str, title: &str) -> WinResult<IShellLinkW> {
    let link: IShellLinkW = unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }?;
    unsafe {
        link.SetPath(&HSTRING::from(exe_path.as_os_str()))?;
        link.SetArguments(&HSTRING::from(args))?;
        link.SetIconLocation(&HSTRING::from(exe_path.as_os_str()), 0)?;
    }
    let store: IPropertyStore = link.cast()?;
    unsafe {
        store.SetValue(&PKEY_Title, &PROPVARIANT::from(title))?;
        store.Commit()?;
    }
    Ok(link)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_extra_args_means_no_intent() {
        let cwd = Path::new("C:\\");
        assert!(matches!(
            launch_intent(["rubrica.exe".to_string()], cwd),
            LaunchIntent::None
        ));
    }

    #[test]
    fn new_window_flag_is_recognized() {
        let cwd = Path::new("C:\\");
        assert!(matches!(
            launch_intent(["rubrica.exe".to_string(), "--new-window".to_string()], cwd),
            LaunchIntent::NewWindow
        ));
    }

    #[test]
    fn absolute_path_argument_is_passed_through() {
        let cwd = Path::new("C:\\Users\\someone");
        match launch_intent(
            ["rubrica.exe".to_string(), "C:\\docs\\a.pdf".to_string()],
            cwd,
        ) {
            LaunchIntent::OpenFile(path) => assert_eq!(path, "C:\\docs\\a.pdf"),
            _ => panic!("expected OpenFile"),
        }
    }

    #[test]
    fn relative_path_argument_is_resolved_against_cwd() {
        let cwd = Path::new("C:\\Users\\someone\\Documents");
        match launch_intent(["rubrica.exe".to_string(), "a.pdf".to_string()], cwd) {
            LaunchIntent::OpenFile(path) => {
                assert_eq!(path, "C:\\Users\\someone\\Documents\\a.pdf")
            }
            _ => panic!("expected OpenFile"),
        }
    }

    #[test]
    fn portable_env_var_toggles_is_portable() {
        // SAFETY: this test's own env var, restored before returning.
        unsafe { std::env::set_var(PORTABLE_ENV_VAR, "1") };
        assert!(is_portable());
        unsafe { std::env::remove_var(PORTABLE_ENV_VAR) };
        assert!(!is_portable());
    }
}
