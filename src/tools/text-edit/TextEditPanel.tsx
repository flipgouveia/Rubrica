// The text-edit tool's side panel (TOOL-API.md `ToolPanelProps`): mode
// switcher (select/edit existing runs, add a text box, add an image),
// per-mode controls, the current selection's info + delete action, and a
// persistent explanation of the tool's most surprising behavior — CONTRACTS
// / ARCHITECTURE.md are explicit that editing a run never reflows its
// neighbors, which is NOT how a word processor behaves, so this is called
// out here as a small standing note rather than a one-time modal a user can
// dismiss and forget (brief item 5).
//
// Image-object delete design decision (brief's "real, load-bearing gap"):
// CONTRACTS' `imageobj_add` returns only a `MutationResult` (see
// `TextEditOverlay.tsx`'s header comment) — no id, and there is no getter
// for image objects at all (`text_objects` only ever returns text runs).
// There is therefore no honest way to let a user click an existing image
// and delete IT SPECIFICALLY through this tool: doing so would require
// either inventing an id the backend doesn't give us, or guessing based on
// position/order, both of which would silently break the moment two images
// share a page or the document is saved and reopened. Chosen resolution:
// images are placed, not managed — this tool never offers a delete
// affordance for them, and the panel says so plainly (Ctrl+Z / the
// toolbar's undo button is the real, honest way to remove one right after
// adding it). Text runs are unaffected by this — `object_delete` gets a
// real `objectId` for those, from `text_objects`, and works fully.
import { useTranslation } from "react-i18next";
import { ImagePlus, MousePointer2, Trash2, Type } from "lucide-react";
import type { ToolPanelProps } from "../../chrome/tool-api";
import { Button } from "../../tokens/components";
import { deleteSelectedTextObject } from "./actions";
import { DEFAULT_IMAGE_RECT_SIZE_PT, DEFAULT_TEXT_RECT_SIZE_PT, type TextEditMode, useTextEditStore } from "./model";
import { substitutionKey, useSubstitutionStore } from "./substitutionStore";
import { useSelectedTextRun } from "./useTextRuns";

const MODES: { mode: TextEditMode; icon: typeof MousePointer2 }[] = [
  { mode: "select", icon: MousePointer2 },
  { mode: "addText", icon: Type },
  { mode: "addImage", icon: ImagePlus },
];

export function TextEditPanel({ docId }: ToolPanelProps) {
  const { t } = useTranslation(["tools-textedit", "common"]);
  const mode = useTextEditStore((s) => s.mode);
  const setMode = useTextEditStore((s) => s.setMode);
  const newTextStyle = useTextEditStore((s) => s.newTextStyle);
  const setNewTextStyle = useTextEditStore((s) => s.setNewTextStyle);
  const imagePath = useTextEditStore((s) => s.imagePath);
  const setImagePath = useTextEditStore((s) => s.setImagePath);
  const selection = useTextEditStore((s) => s.selection);

  const selectedRun = useSelectedTextRun(docId);
  const substituted = useSubstitutionStore((s) => (selection ? s.substitutedKeys.has(substitutionKey(selection.docId, selection.objectId)) : false));

  const activeSelection = selection && selection.docId === docId ? selection : null;

  return (
    <div className="flex h-full flex-col gap-4 bg-background p-4 text-text">
      <header>
        <h2 className="font-display text-base font-semibold">{t("tools-textedit:tools-textedit.panel.title")}</h2>
      </header>

      <p className="rounded-sm bg-accent/10 px-2.5 py-2 text-xs text-accent">{t("tools-textedit:tools-textedit.panel.noReflowHint")}</p>

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-text">{t("tools-textedit:tools-textedit.panel.modeLabel")}</span>
        {/* `flex-wrap` (not a single forced-equal-width row): each button's own label is `whitespace-nowrap` (Button.tsx's base style), so three labels rarely fit one 288px-wide panel row without wrapping — letting the row wrap keeps every label fully readable instead of overflowing the panel horizontally. */}
        <div className="flex flex-wrap gap-1.5">
          {MODES.map(({ mode: candidate, icon: Icon }) => (
            <Button
              key={candidate}
              variant={mode === candidate ? "primary" : "secondary"}
              size="sm"
              aria-pressed={mode === candidate}
              onClick={() => setMode(candidate)}
            >
              <Icon className="h-4 w-4" />
              {t(`tools-textedit:tools-textedit.panel.modes.${candidate}`)}
            </Button>
          ))}
        </div>
      </div>

      {mode === "select" && (
        <p className="text-xs text-muted-text">{t("tools-textedit:tools-textedit.panel.selectHint")}</p>
      )}

      {mode === "addText" && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <p className="text-xs text-muted-text">
            {t("tools-textedit:tools-textedit.panel.addTextHint", { width: DEFAULT_TEXT_RECT_SIZE_PT.width, height: DEFAULT_TEXT_RECT_SIZE_PT.height })}
          </p>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-text">{t("tools-textedit:tools-textedit.panel.fontSizeLabel")}</span>
            <input
              type="number"
              min={4}
              max={144}
              value={newTextStyle.fontSize}
              onChange={(event) => setNewTextStyle({ fontSize: Number(event.target.value) || newTextStyle.fontSize })}
              className="h-8 rounded-sm border border-border-strong bg-surface px-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-text">{t("tools-textedit:tools-textedit.panel.colorLabel")}</span>
            <input
              type="color"
              value={newTextStyle.color}
              onChange={(event) => setNewTextStyle({ color: event.target.value })}
              className="h-8 w-full cursor-pointer rounded-sm border border-border-strong bg-surface p-0.5"
            />
          </label>
        </div>
      )}

      {mode === "addImage" && (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
          <p className="text-xs text-muted-text">
            {t("tools-textedit:tools-textedit.panel.addImageHint", { width: DEFAULT_IMAGE_RECT_SIZE_PT.width, height: DEFAULT_IMAGE_RECT_SIZE_PT.height })}
          </p>
          <label className="flex flex-col gap-1 text-xs">
            <span className="font-medium text-text">{t("tools-textedit:tools-textedit.panel.imagePathLabel")}</span>
            <input
              type="text"
              value={imagePath}
              onChange={(event) => setImagePath(event.target.value)}
              placeholder={t("tools-textedit:tools-textedit.panel.imagePathPlaceholder")}
              className="h-8 rounded-sm border border-border-strong bg-surface px-2 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            />
          </label>
          {!imagePath.trim() && <p className="text-xs text-muted-text">{t("tools-textedit:tools-textedit.panel.imagePathRequired")}</p>}
          <p className="rounded-sm bg-danger/10 px-2 py-1.5 text-xs text-danger">{t("tools-textedit:tools-textedit.panel.imageDeleteNote")}</p>
        </div>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-border pt-3">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-text">{t("tools-textedit:tools-textedit.panel.selectionLabel")}</span>
        {!activeSelection ? (
          <p className="text-xs text-muted-text">{t("tools-textedit:tools-textedit.panel.noSelection")}</p>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-xs text-text">{t("tools-textedit:tools-textedit.panel.selectedOnPage", { page: activeSelection.page + 1 })}</p>
            {selectedRun && (
              <p className="truncate text-xs text-muted-text" title={selectedRun.text}>
                {t("tools-textedit:tools-textedit.panel.selectedText", { text: selectedRun.text })}
              </p>
            )}
            {substituted && <p className="text-xs text-danger">{t("tools-textedit:tools-textedit.panel.fontSubstitutedNote")}</p>}
            <Button variant="danger" size="sm" onClick={() => void deleteSelectedTextObject()}>
              <Trash2 className="h-4 w-4" />
              {t("common:common.actions.delete")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
