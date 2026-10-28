# Installing Rubrica (Windows)

Rubrica ships two ways from every [GitHub Release](https://github.com/flipgouveia/Rubrica/releases):
an installer and a portable `.zip`. Both are the same app; pick whichever fits.

## Installer (`Rubrica_<version>_x64-setup.exe`)

Double-click it and follow the wizard — pick a language, click through. It installs
**per-user, with no administrator prompt** (into `%LOCALAPPDATA%\Rubrica`), adds a Start Menu
shortcut, and registers Rubrica as a PDF viewer/editor you can pick from "Open with" (see
[File association](#file-association) below — it never changes your current default PDF app on
its own).

Uninstalling (Settings → Apps, or the Start Menu entry) removes the app and its Start Menu
shortcut. It leaves every PDF you ever opened exactly where it was — Rubrica never copies or
moves your documents. A checkbox on the uninstall screen additionally offers to delete Rubrica's
own local data (`%APPDATA%\Rubrica`: your recent-files list and preferences); leave it unchecked
to keep that data for a future reinstall.

## Portable (`rubrica-<version>-portable-x64.zip`)

Unzip it anywhere — a USB drive, a network share, a folder with no install step at all — and run
`Rubrica.exe`. The presence of the `portable.txt` file next to the exe is what makes it portable:
Rubrica keeps its recent-files list, preferences, and crash-recovery data in a `data\` folder it
creates right there next to the exe, instead of your Windows profile. Delete the whole folder and
nothing of Rubrica is left on the machine.

The portable build never checks for updates and has no updater UI at all — grab a new `.zip` from
Releases when you want to upgrade, and copy your `data\` folder over if you want to keep your
recents/preferences.

## File association

Windows never lets an installer silently take over what opens your PDFs — only you choose a
default, in Settings → Apps → Default apps. Installing Rubrica makes it available as a choice
there and in any file's right-click **Open with**, but your existing default PDF viewer (if any)
is untouched. To make Rubrica the default:

1. Right-click any `.pdf` file → **Open with** → **Choose another app** → pick **Rubrica** →
   check **Always use this app to open .pdf files**.
2. Or: Settings → **Apps** → **Default apps** → search **Rubrica** → set it for `.pdf`.

Once Rubrica is running, double-clicking another PDF opens it as a new tab in the same window
instead of a second copy of the app.

## Updates

Rubrica checks GitHub Releases for a newer version on startup (once — this can be turned off in
Settings; the portable build never checks at all, see above). If one is available, a small notice
appears with an **Install and restart** button — nothing downloads or installs until you click
it. Update packages are signed (see [Update signing](#update-signing-maintainers) below); Rubrica
verifies that signature before installing anything.

## Verifying your download

Every release lists a `SHA256SUMS.txt` file next to the installer and the portable `.zip`. It holds
a "fingerprint" (SHA-256) of each file. If the fingerprint of the file you downloaded matches, the
file is exactly what was published and wasn't corrupted or swapped on the way to you.

1. Download `SHA256SUMS.txt` from the same release page.
2. Open PowerShell in your Downloads folder and run (use the real file name):

   ```powershell
   Get-FileHash .\Rubrica_0.2.0_x64-setup.exe -Algorithm SHA256
   ```

3. Compare the `Hash` it prints with the line for that file in `SHA256SUMS.txt`
   (upper/lower case doesn't matter). They must be identical.

Releases are also built by this repository's GitHub Actions and carry a signed "build
provenance" attestation — proof that the file came out of this repo's automated build. If you
have the [GitHub CLI](https://cli.github.com/), you can check it:

```powershell
gh attestation verify .\Rubrica_0.2.0_x64-setup.exe -R flipgouveia/Rubrica
```

## About the SmartScreen warning

Rubrica's installer isn't signed with a paid code-signing certificate (Authenticode) yet. The
first time you run it, Windows SmartScreen may show a blue **"Windows protected your PC"**
screen. That is normal for small, independent apps: it doesn't mean the file is unsafe, only that
Windows hasn't seen enough copies of it yet to vouch for the publisher.

To continue: click **More info**, then **Run anyway**.

Is it safe? If the SHA-256 checksum of your download matches `SHA256SUMS.txt` (see
[Verifying your download](#verifying-your-download)) and you got it from this project's Releases
page, then it is the exact file the project built. If the checksum does *not* match, don't run
it — download it again, and report it if it keeps happening.

---
## Update signing (maintainers)

The updater's signing keypair lives outside the repository, in the owner's `.secrets/` folder
(gitignored; never commit either half): `rubrica-updater.key` (private), `rubrica-updater.key.pub`
(public) and `updater-key-password.txt`. It was generated with:

```bash
pnpm tauri signer generate -w .secrets/rubrica-updater.key
```

- The **public** key is embedded in `src-tauri/tauri.conf.json` under `plugins.updater.pubkey`
  (safe to commit, that's the point of a public key).
- The **private** key and its password are stored as GitHub Actions secrets, which
  `.github/workflows/release.yml` reads:
  - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `rubrica-updater.key`.
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the key's password.
  Update them with `gh secret set <NAME> -R flipgouveia/Rubrica < file`.

**Back up `.secrets/` somewhere safe and offline** (password manager, encrypted USB drive).
GitHub secrets can't be read back. If the private key or its password is lost, every installed
copy of Rubrica can no longer auto-update: a new keypair means a new `pubkey`, and nobody on the
old key can verify updates signed with it — they'd have to reinstall manually once.

Release tags (`v*`) are protected by a repository ruleset: only repository admins can create,
move or delete them, so only the owner can trigger a release build.
## Cutting a release (maintainers)

1. Bump `version` in `src-tauri/tauri.conf.json` (and `Cargo.toml`/`package.json` if you keep
   them in sync), commit.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds the updater-signed NSIS installer and the portable `.zip`, writes
   `SHA256SUMS.txt`, attests build provenance, and opens a **draft** Release with all of them
   attached (plus `latest.json`) and auto-generated notes. `ci.yml`'s own debug
   bundle (built on every push, unsigned, unrelated to this) is not involved.
4. Edit the draft's notes if you want, then click **Publish release**. Only then does
   `releases/latest/download/latest.json` — the URL every installed copy of Rubrica polls — start
   pointing at it; existing installs pick it up on their next startup check.
