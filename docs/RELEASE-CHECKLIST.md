# Release checklist

CI proves that Rubrica builds and that its engine and UI tests pass. It can't prove that the
real app works for a person clicking through it, so every release gets this manual pass before
the draft release is published. Test the files from the **draft release itself**, not a local
build: those are exactly what users will download.

## 1. Before tagging

- [ ] `main` is green in CI.
- [ ] Version bumped in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`
      (all three must match the tag).
- [ ] `CHANGELOG.md` has a section for the new version, and the `[Unreleased]`/version links at
      the bottom point at the new tag.

## 2. Tag and build

```bash
git tag v<version> origin/main
git push origin v<version>
```

The Release workflow builds everything and creates a **draft** release. Check that the draft has:

- [ ] `Rubrica_<version>_x64-setup.exe` (installer) and its `.sig`
- [ ] `rubrica-<version>-portable-x64.zip`
- [ ] `latest.json` (auto-update manifest)
- [ ] `SHA256SUMS.txt`
- [ ] The workflow's "Attest build provenance" step succeeded

## 3. Verify the downloads

- [ ] `Get-FileHash <file> -Algorithm SHA256` matches `SHA256SUMS.txt` for the installer and the zip.
- [ ] `gh attestation verify <file> -R flipgouveia/Rubrica` passes for both.

## 4. Smoke test: installer

On a Windows machine:

- [ ] The installer runs without asking for administrator rights; SmartScreen's "More info → Run
      anyway" works.
- [ ] Rubrica starts from the Start Menu, and the window, taskbar and Start Menu show the
      Rubrica icon.
- [ ] Open a text PDF: pages render, scroll and zoom are smooth, thumbnails and the outline show.
- [ ] Search: a simple word, a proximity search with three words, a chapter-scoped search.
- [ ] Annotate: a highlight, a freehand drawing, a sticky note and a shape.
- [ ] Pages: reorder, rotate, delete and insert a blank page; undo and redo.
- [ ] Forms (`fixtures/form.pdf`): tick a checkbox; a text field shows "Not saved".
- [ ] Edit text: change a word in place; add a text box.
- [ ] Redact: redact a line, save, and confirm the text can no longer be selected or found.
- [ ] Save, close, reopen: every change is still there.
- [ ] "Open with → Rubrica" on a `.pdf` in Explorer opens it in a tab; the Jump List shows recents.
- [ ] Uninstall from Settings → Apps removes the app and leaves the PDFs untouched.

## 5. Smoke test: portable

On a machine **without** Rubrica installed:

- [ ] Unzip anywhere (for example a USB drive) and run `Rubrica.exe`.
- [ ] A `data\` folder appears next to the exe (with `Roaming\`, `Local\` and `WebView2\`
      inside), nothing is written to `%APPDATA%\Rubrica`, and `%LOCALAPPDATA%\app.rubrica.desktop`
      stays empty.
- [ ] Open, edit and save a PDF; close and reopen Rubrica: recents and preferences are kept.
- [ ] No update check happens.

## 6. Saved files open everywhere

- [ ] Run the [portability checklist](PORTABILITY-CHECKLIST.md): files saved by Rubrica open
      correctly in Acrobat Reader and in a browser.

## 7. Publish

- [ ] Write the release notes in plain language (what's new, known limitations, how to verify
      the download).
- [ ] Publish the draft. It becomes "Latest", which is what the auto-updater reads.
- [ ] From the next release on: install the previous version, publish the new one, and confirm
      the installed copy offers the update and updates cleanly.
