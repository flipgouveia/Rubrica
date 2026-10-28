use std::path::{Path, PathBuf};

/// Copies the vendored Pdfium dynamic library next to the build output so that
/// `Pdfium::bind_to_library` can find it by looking in the same folder as the
/// running executable — both for `cargo test` / `cargo run` / `tauri dev` (where
/// the executable lives under `target/<profile>/`, or `target/<profile>/deps/`
/// for test binaries) and, eventually, for a portable-exe distribution where the
/// dll genuinely ships alongside the app binary. The installed (NSIS) bundle
/// instead gets its own copy via `bundle.resources` in `tauri.conf.json`,
/// resolved at runtime through Tauri's resource directory API.
fn copy_pdfium_next_to_build_output() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let pdfium_dll = manifest_dir.join("pdfium").join("bin").join("pdfium.dll");

    if !pdfium_dll.exists() {
        panic!(
            "vendored Pdfium library not found at {}. \
             Run the setup described in src-tauri/pdfium/README.md.",
            pdfium_dll.display()
        );
    }

    println!("cargo:rerun-if-changed={}", pdfium_dll.display());

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR not set by cargo"));

    // OUT_DIR looks like `<target_dir>/<profile>/build/<pkg>-<hash>/out`; walk up
    // three levels to land on `<target_dir>/<profile>/`.
    let Some(profile_dir) = out_dir.ancestors().nth(3).map(Path::to_path_buf) else {
        println!(
            "cargo:warning=could not derive profile dir from OUT_DIR={}; skipping pdfium.dll copy",
            out_dir.display()
        );
        return;
    };

    for dest_dir in [profile_dir.clone(), profile_dir.join("deps")] {
        if let Err(err) = std::fs::create_dir_all(&dest_dir) {
            println!(
                "cargo:warning=could not create {}: {err}",
                dest_dir.display()
            );
            continue;
        }
        let dest = dest_dir.join("pdfium.dll");
        if let Err(err) = std::fs::copy(&pdfium_dll, &dest) {
            println!(
                "cargo:warning=could not copy pdfium.dll to {}: {err}",
                dest.display()
            );
        }
    }
}

/// `tauri-build`'s own Windows manifest embedding only applies to the final
/// app binary (`rustc-link-arg-bins`), not to `cargo test` targets — so any
/// test that links `tauri`'s runtime types loads the OS's stub ComCtl5
/// facade instead of ComCtl6 and fails at process start with
/// `STATUS_ENTRYPOINT_NOT_FOUND` (see tauri-apps/tauri#13419). Work around it
/// exactly as a Tauri maintainer recommended there: disable tauri-build's
/// bins-only manifest and embed the same manifest ourselves via a plain
/// `rustc-link-arg`, which (without the `-bins` suffix) applies to every
/// link target, tests included.
#[cfg(windows)]
fn embed_windows_manifest_for_every_target() {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("windows-app-manifest.xml");
    println!("cargo:rerun-if-changed={}", manifest.display());
    println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
    println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
}

fn main() {
    copy_pdfium_next_to_build_output();

    #[cfg(windows)]
    {
        embed_windows_manifest_for_every_target();
        let attributes = tauri_build::Attributes::new()
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
        tauri_build::try_build(attributes).expect("failed to run tauri-build");
    }

    #[cfg(not(windows))]
    tauri_build::build();
}
