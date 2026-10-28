// Inline text entry shown right after a `freeText` box is dragged out, filling
// its screen rect. CONTRACTS' `AnnotPatch` has no `text` field (see
// `AnnotationLayer.tsx`'s header comment for the gap this implies), so this
// editor is creation-only: it exists to collect the text for one `annot_add`
// call and then unmounts. There is deliberately no re-opening of this editor
// for an existing `freeText` annotation — that would silently pretend
// editing works when the IPC surface can't actually persist it.
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ScreenRect } from "../shared/coords";

export interface FreeTextEditorProps {
  rect: ScreenRect;
  color: string;
  fontSizePx: number;
  onCommit: (text: string) => void;
  onCancel: () => void;
}

export function FreeTextEditor({ rect, color, fontSizePx, onCommit, onCancel }: FreeTextEditorProps) {
  const { t } = useTranslation("tools-annotate");
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const commitOrCancel = () => {
    if (value.trim().length > 0) onCommit(value);
    else onCancel();
  };

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={commitOrCancel}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          commitOrCancel();
        }
      }}
      placeholder={t("tools-annotate.freeText.placeholder")}
      className="absolute z-20 resize-none border border-dashed border-accent bg-surface/90 p-1 leading-tight outline-none"
      style={{
        left: rect.x,
        top: rect.y,
        width: Math.max(rect.width, 80),
        height: Math.max(rect.height, fontSizePx * 1.6),
        color,
        fontSize: fontSizePx,
      }}
    />
  );
}
