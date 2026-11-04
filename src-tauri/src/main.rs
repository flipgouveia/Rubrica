// Prevents an additional console window on Windows in release builds.
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

/// R7 (Windows citizenship): the portable .exe is the exact same binary as
/// the installed one — what makes it "portable" is that `store::Store::open`
/// (`%APPDATA%\Rubrica`) and `engine::journal` (`%LOCALAPPDATA%\Rubrica`,
/// CONTRACTS §8) resolve under this process's own `APPDATA`/`LOCALAPPDATA`
/// environment variables. Both are session-core files R7 must not touch, so
/// this redirects those two variables *before* `rubrica_lib::run()` ever
/// calls into either — done here, in `main`, rather than inside the library,
/// so it happens exactly once, before anything reads them.
///
/// Detected by a `portable.txt` marker sitting next to the exe (present only
/// in the zipped portable distribution assembled by the release workflow —
/// see `docs/INSTALL.md`); an installed copy never has this file next to it.
fn redirect_portable_app_data() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(exe_dir) = exe.parent() else {
        return;
    };
    if !exe_dir.join("portable.txt").exists() {
        return;
    }

    let roaming = exe_dir.join("data").join("Roaming");
    let local = exe_dir.join("data").join("Local");
    // WebView2 resolves its own profile folder through the Windows known-folder
    // API, not `LOCALAPPDATA`, so without this its ~8 MB browser cache lands in
    // `%LOCALAPPDATA%\app.rubrica.desktop` even in portable mode. WebView2 reads
    // this variable in preference to the folder Tauri passes it.
    let webview = exe_dir.join("data").join("WebView2");
    if std::fs::create_dir_all(&roaming).is_err() || std::fs::create_dir_all(&local).is_err() {
        eprintln!("rubrica: portable.txt found but could not create a local data\\ folder next to the exe; falling back to the normal per-user profile paths");
        return;
    }

    // SAFETY: single-threaded at this point (first thing in `main`, before
    // `rubrica_lib::run()` spawns anything that could read these).
    unsafe {
        std::env::set_var("APPDATA", &roaming);
        std::env::set_var("LOCALAPPDATA", &local);
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", &webview);
        std::env::set_var("RUBRICA_PORTABLE", "1");
    }
}

fn main() {
    redirect_portable_app_data();
    rubrica_lib::run();
}
