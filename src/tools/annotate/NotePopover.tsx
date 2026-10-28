// Inline editor for a `note` annotation's `contents` text. Positioned by the
// caller (`AnnotationLayer`) as an absolutely-placed sibling of the SVG
// overlay, next to the note's icon — not a centered `Dialog`, since it needs
// to stay anchored to a point on the page rather than take over the screen.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../../tokens/components";
import { DeleteIcon } from "./icons";

export interface NotePopoverProps {
  x: number;
  y: number;
  initialContents: string;
  onCommit: (contents: string) => void;
  onDelete: () => void;
  onClose: () => void;
}

/** Note popovers open with the icon's top-left roughly here, nudged so the editor doesn't run off the right/bottom of a typical page. */
export function NotePopover({ x, y, initialContents, onCommit, onDelete, onClose }: NotePopoverProps) {
  const { t } = useTranslation("tools-annotate");
  const [value, setValue] = useState(initialContents);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  const commitAndClose = () => {
    if (value !== initialContents) onCommit(value);
    onClose();
  };

  return (
    <div
      className="absolute z-20 flex w-64 flex-col gap-2 rounded-md border border-border bg-surface-raised p-2.5 shadow-menu"
      style={{ left: x, top: y }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          commitAndClose();
        }
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-text">{t("tools-annotate.note.title")}</span>
        <IconButton size="sm" variant="danger" aria-label={t("tools-annotate.note.delete")} onClick={onDelete}>
          <DeleteIcon />
        </IconButton>
      </div>
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commitAndClose}
        placeholder={t("tools-annotate.note.placeholder")}
        rows={4}
        className="w-full resize-none rounded-sm border border-border bg-surface p-1.5 text-sm text-text outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
      />
    </div>
  );
}
