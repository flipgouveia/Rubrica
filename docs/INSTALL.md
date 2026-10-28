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

## About the SmartScreen warning

Rubrica's installer isn't signed with a paid code-signing certificate (Authenticode) yet — that's
a deliberate, deferred decision (see `docs/ARCHITECTURE.md`), not an oversight. The first time you
run it, Windows SmartScreen will show a blue "Windows protected your PC" screen. This is normal
for any small, independently-published app without that certificate; it does not mean the file is
unsafe, only that Windows hasn't seen enough copies of it yet to vouch for the publisher. To
proceed: click **More info**, then **Run anyway**.

If you'd rather verify the download yourself first: build Rubrica from source (see the repository
README), or compare the release asset against the SHA-256 checksum GitHub shows on the release
page.

---

## Update signing (maintainers)

The updater's signing keypair lives outside the repository — `.secrets/rubrica-updater.key` /
`.key.pub` locally (gitignored; never commit either half), generated once with:

```bash
pnpm tauri signer generate -w .secrets/rubrica-updater.key
```

- The **public** key's content is already embedded in `src-tauri/tauri.conf.json` under
  `plugins.updater.pubkey` — safe to commit, that's the point of a public key.
- The **private** key and its password must be added as repository secrets (Settings → Secrets
  and variables → Actions) before `.github/workflows/release.yml` can produce signed updater
  artifacts:
  - `TAURI_SIGNING_PRIVATE_KEY` — the full contents of `.secrets/rubrica-updater.key`.
  - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — the password chosen when generating it.

Losing the private key means every future release must ship a **new** keypair (a new `pubkey` in
`tauri.conf.json`), and nobody on the old key can auto-update to it — they'd need to reinstall
manually once. Keep a backup of `.secrets/rubrica-updater.key` and its password somewhere durable
(a password manager, not the repo).

## Cutting a release (maintainers)

1. Bump `version` in `src-tauri/tauri.conf.json` (and `Cargo.toml`/`package.json` if you keep
   them in sync), commit.
2. Tag it and push the tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds the signed NSIS installer and the portable `.zip`, and
   opens a **draft** Release with both attached and auto-generated notes. `ci.yml`'s own debug
   bundle (built on every push, unsigned, unrelated to this) is not involved.
4. Edit the draft's notes if you want, then click **Publish release**. Only then does
   `releases/latest/download/latest.json` — the URL every installed copy of Rubrica polls — start
   pointing at it; existing installs pick it up on their next startup check.
