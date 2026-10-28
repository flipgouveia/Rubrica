import { clsx } from "clsx";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import type { PageSize } from "../../ipc/bindings";
import { GripIcon } from "./icons";

export interface SelectModifiers {
  ctrl: boolean;
  shift: boolean;
}

export interface PageThumbnailProps {
  index: number;
  page: PageSize;
  /** Pre-built `<img src>` for this page — see `PagesPanel`'s `thumbSrc` helper. */
  thumbSrc: string;
  selected: boolean;
  /** True while this exact thumbnail is the one currently being dragged. */
  dragging: boolean;
  disabled: boolean;
  onSelect: (index: number, modifiers: SelectModifiers) => void;
  onDeleteKey: () => void;
  onHandlePointerDown: (event: ReactPointerEvent<HTMLButtonElement>, index: number) => void;
  registerRef: (index: number, el: HTMLDivElement | null) => void;
}

/**
 * One thumbnail card: drag handle (pointer-driven reorder), the placeholder
 * image itself sized to the page's actual aspect ratio (the only way, given
 * CONTRACTS' `PageSize`-only surface, to make a 90/270 rotation visible —
 * see the summary's CONTRACTS-gap note about 180 rotations being invisible
 * to the UI), and a 1-based page-number label. Clicking anywhere on the
 * card (other than the drag handle) selects it, honoring ctrl/cmd-toggle
 * and shift-range modifiers read straight off the event.
 */
export function PageThumbnail({
  index,
  page,
  thumbSrc,
  selected,
  dragging,
  disabled,
  onSelect,
  onDeleteKey,
  onHandlePointerDown,
  registerRef,
}: PageThumbnailProps) {
  const { t } = useTranslation("tools-pages");
  const pageNumber = index + 1;
  const width = page.width ?? 612;
  const height = page.height ?? 792;

  function select(modifiers: SelectModifiers) {
    if (disabled) return;
    onSelect(index, modifiers);
  }

  function handleClick(event: ReactMouseEvent) {
    select({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
  }

  function handleKeyDown(event: ReactKeyboardEvent) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select({ ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey });
    } else if (event.key === "Delete") {
      event.preventDefault();
      onDeleteKey();
    }
  }

  return (
    <div
      ref={(el) => registerRef(index, el)}
      data-page-index={index}
      role="button"
      aria-pressed={selected}
      aria-label={t("tools-pages.actions.selectPage", { page: pageNumber })}
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={clsx(
        "group relative flex w-40 flex-none flex-col gap-1.5 rounded-md border p-1.5 outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        selected ? "border-accent bg-accent/10" : "border-border bg-surface hover:border-border-strong",
        dragging && "opacity-40",
        disabled && "pointer-events-none opacity-60",
      )}
    >
      <button
        type="button"
        aria-label={t("tools-pages.actions.dragHandle", { page: pageNumber })}
        onPointerDown={(event) => onHandlePointerDown(event, index)}
        onClick={(event) => event.stopPropagation()}
        disabled={disabled}
        className={clsx(
          "absolute right-1.5 top-1.5 flex h-6 w-6 cursor-grab items-center justify-center rounded-sm",
          "text-muted-text opacity-0 transition-opacity hover:bg-border/60",
          "group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none",
          "focus-visible:ring-2 focus-visible:ring-focus-ring active:cursor-grabbing",
        )}
      >
        <GripIcon />
      </button>

      <img
        src={thumbSrc}
        alt={t("tools-pages.panel.pageAlt", { page: pageNumber })}
        draggable={false}
        style={{ aspectRatio: `${width} / ${height}` }}
        className="w-full rounded-sm border border-border bg-background object-contain"
      />

      <span className="text-center text-xs text-muted-text">{t("tools-pages.panel.pageLabel", { page: pageNumber })}</span>
    </div>
  );
}
