; R7 (Windows citizenship) — custom NSIS hooks merged into Tauri's own
; installer.nsi template via tauri.conf.json's bundle.windows.nsis.installerHooks.
;
; Deliverable 2 ("File association"): per-user ".pdf" *capability*
; registration — Rubrica shows up in "Open with" / Settings > Default apps,
; but never becomes the default handler on its own. Deliberately NOT
; tauri.conf.json's own `bundle.fileAssociations` field: that feature's
; APP_ASSOCIATE macro (crates/tauri-bundler/.../FileAssociation.nsh) writes
; ".pdf"'s raw Classes default value directly, which *does* make Rubrica the
; default the first time a user without an existing default installs it —
; exactly what the brief says never to do. This hand-writes the same
; "RegisteredApplications" / "Capabilities" / "OpenWithProgids" scheme
; Windows' own Default Programs UI is built on instead (used by e.g. Chrome
; and Firefox for "available but not default"), and never touches
; "Software\Classes\.pdf"'s own default value.
;
; SHCTX is NSIS's own per-run alias for HKLM/HKCU, already used throughout
; Tauri's installer.nsi — with tauri.conf.json's installMode "currentUser"
; it always resolves to HKCU here.

!macro RubricaRegisterFileAssociation
  WriteRegStr SHCTX "Software\Classes\Rubrica.PDF" "" "Rubrica PDF Document"
  WriteRegStr SHCTX "Software\Classes\Rubrica.PDF\DefaultIcon" "" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "Software\Classes\Rubrica.PDF\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'

  ; Capability registration (Microsoft's "Default Programs" scheme) — makes
  ; Rubrica selectable without ever setting ".pdf"'s own default value.
  WriteRegStr SHCTX "Software\Rubrica\Capabilities" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "Software\Rubrica\Capabilities" "ApplicationDescription" "Rubrica is a local-first PDF viewer and editor."
  WriteRegStr SHCTX "Software\Rubrica\Capabilities\FileAssociations" ".pdf" "Rubrica.PDF"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Rubrica" "Software\Rubrica\Capabilities"

  ; Also list Rubrica in the plain right-click "Open with" picker for .pdf,
  ; again without touching the default.
  WriteRegStr SHCTX "Software\Classes\.pdf\OpenWithProgids" "Rubrica.PDF" ""

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro RubricaUnregisterFileAssociation
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Rubrica"
  DeleteRegKey SHCTX "Software\Rubrica\Capabilities"
  DeleteRegKey /ifempty SHCTX "Software\Rubrica"
  DeleteRegValue SHCTX "Software\Classes\.pdf\OpenWithProgids" "Rubrica.PDF"
  DeleteRegKey SHCTX "Software\Classes\Rubrica.PDF"

  System::Call "shell32::SHChangeNotify(i,i,i,i) (0x08000000, 0x1000, 0, 0)"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro RubricaRegisterFileAssociation
!macroend

; Runs before the stock uninstall section deletes any files — verified
; against a real install/uninstall rehearsal (see the R7 report) that
; without this, "$LOCALAPPDATA\Rubrica" (== $INSTDIR under installMode
; "currentUser") survives uninstall: the autosave journal directory
; (CONTRACTS.md §8) is written by the *running app*, not the installer, so
; it isn't in the installer's own file manifest and the stock template's
; final plain `RMDir "$INSTDIR"` (non-recursive) silently no-ops on a
; directory that still has a "journal" subfolder in it. A crash journal is
; disposable scratch state, not "user data" — delete it unconditionally
; (not gated on the checkbox below) so $INSTDIR is empty by the time the
; stock code tries to remove it.
!macro NSIS_HOOK_PREUNINSTALL
  RmDir /r "$INSTDIR\journal"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro RubricaUnregisterFileAssociation

  ; Deliverable 1 ("uninstaller... asks about %APPDATA%\Rubrica"): the stock
  ; template's own "Delete the application data" checkbox
  ; ($DeleteAppDataCheckboxState, set on the uninstall confirm page) only
  ; ever clears "$APPDATA\${BUNDLEID}"/"$LOCALAPPDATA\${BUNDLEID}", where
  ; BUNDLEID is the reverse-DNS identifier (app.rubrica.desktop) — but
  ; CONTRACTS.md §8 puts Rubrica's real SQLite store at "%APPDATA%\Rubrica"
  ; directly, not under the identifier. Honor the same checkbox for the
  ; folder Rubrica actually uses.
  ${If} $DeleteAppDataCheckboxState = 1
    SetShellVarContext current
    RmDir /r "$APPDATA\Rubrica"
  ${EndIf}
!macroend
