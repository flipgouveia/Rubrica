// Mode picker + style controls for the annotation tool. Deliberately a
// sibling of `AnnotationLayer`, not its parent or child — both take
// `{ mode, style }` (and here, additionally `selectedAnnot`) as props from
// whatever host lifts that state (today: `dev/AnnotateHarness.tsx`), so
// neither component needs to know the other exists. See `model.ts`'s
// `canPatchColor`/`canPatchOpacity` for exactly which kinds this toolbar can
// live-edit — the rest (stroke width, font size, shape kind, fill) only
// ever affects the *pending* style for annotations not yet created, since
// CONTRACTS' `AnnotPatch` has no field for any of them.
import { useId } from "react";
import type { ReactElement, ReactNode, SVGProps } from "react";
import { useTranslation } from "react-i18next";
import { commands } from "../../ipc";
import type { Annot, ShapeKind } from "../../ipc/bindings";
import { IconButton, Menu, Tooltip } from "../../tokens/components";
import {
  ArrowShapeIcon,
  DeleteIcon,
  EllipseShapeIcon,
  FillIcon,
  FreeTextIcon,
  HighlightIcon,
  InkIcon,
  LineShapeIcon,
  NoteIcon,
  RectShapeIcon,
  SelectIcon,
  StrikeoutIcon,
  UnderlineIcon,
} from "./icons";
import { canPatchColor, canPatchOpacity, COLOR_PRESETS, getPatchableColor, getPatchableOpacity, type AnnotationMode, type AnnotationStyle } from "./model";

export interface AnnotationToolbarProps {
  docId: string;
  mode: AnnotationMode;
  onModeChange: (mode: AnnotationMode) => void;
  style: AnnotationStyle;
  onStyleChange: (patch: Partial<AnnotationStyle>) => void;
  selectedAnnot: Annot | null;
  onDeleteSelected: () => void;
}

const SHAPE_ICONS: Record<ShapeKind, (props: SVGProps<SVGSVGElement>) => ReactElement> = {
  rect: RectShapeIcon,
  ellipse: EllipseShapeIcon,
  line: LineShapeIcon,
  arrow: ArrowShapeIcon,
};

export function AnnotationToolbar({ docId, mode, onModeChange, style, onStyleChange, selectedAnnot, onDeleteSelected }: AnnotationToolbarProps) {
  const { t } = useTranslation("tools-annotate");
  const opacityId = useId();
  const widthId = useId();
  const fontSizeId = useId();

  const colorEditable = !selectedAnnot || canPatchColor(selectedAnnot);
  const opacityEditable = !selectedAnnot || canPatchOpacity(selectedAnnot);
  const geometryOnlyEditable = !!selectedAnnot; // width/fontSize/fill/shapeKind never patchable once created.

  const colorValue = selectedAnnot && canPatchColor(selectedAnnot) ? (getPatchableColor(selectedAnnot) ?? style.color) : style.color;
  const opacityValue = selectedAnnot && canPatchOpacity(selectedAnnot) ? (getPatchableOpacity(selectedAnnot) ?? style.opacity) : style.opacity;

  function handleColorChange(color: string) {
    if (selectedAnnot && canPatchColor(selectedAnnot)) {
      void commands.annotUpdate(docId, selectedAnnot.annotId, { color, opacity: null, contents: null, rect: null });
    } else {
      onStyleChange({ color });
    }
  }

  function handleOpacityChange(opacity: number) {
    if (selectedAnnot && canPatchOpacity(selectedAnnot)) {
      void commands.annotUpdate(docId, selectedAnnot.annotId, { color: null, opacity, contents: null, rect: null });
    } else {
      onStyleChange({ opacity });
    }
  }

  const ShapeMenuIcon = SHAPE_ICONS[style.shapeKind];

  return (
    <Tooltip.Provider delayDuration={300}>
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface p-2">
        <div role="toolbar" aria-label={t("tools-annotate.toolbar.ariaLabel")} className="flex items-center gap-1">
          <ModeButton label={t("tools-annotate.toolbar.select")} active={mode === "select"} onClick={() => onModeChange("select")}>
            <SelectIcon />
          </ModeButton>
          <ModeButton label={t("tools-annotate.toolbar.highlight")} active={mode === "highlight"} onClick={() => onModeChange("highlight")}>
            <HighlightIcon />
          </ModeButton>
          <ModeButton label={t("tools-annotate.toolbar.underline")} active={mode === "underline"} onClick={() => onModeChange("underline")}>
            <UnderlineIcon />
          </ModeButton>
          <ModeButton label={t("tools-annotate.toolbar.strikeout")} active={mode === "strikeout"} onClick={() => onModeChange("strikeout")}>
            <StrikeoutIcon />
          </ModeButton>
          <ModeButton label={t("tools-annotate.toolbar.ink")} active={mode === "ink"} onClick={() => onModeChange("ink")}>
            <InkIcon />
          </ModeButton>
          <ModeButton label={t("tools-annotate.toolbar.note")} active={mode === "note"} onClick={() => onModeChange("note")}>
            <NoteIcon />
          </ModeButton>

          <Menu.Root>
            <Tooltip.Root>
              <Tooltip.Trigger asChild>
                <Menu.Trigger asChild>
                  <IconButton aria-label={t("tools-annotate.toolbar.shape")} aria-pressed={mode === "shape"} onClick={() => onModeChange("shape")}>
                    <ShapeMenuIcon />
                  </IconButton>
                </Menu.Trigger>
              </Tooltip.Trigger>
              <Tooltip.Content>{t("tools-annotate.toolbar.shape")}</Tooltip.Content>
            </Tooltip.Root>
            <Menu.Content align="start">
              {(Object.keys(SHAPE_ICONS) as ShapeKind[]).map((kind) => {
                const KindIcon = SHAPE_ICONS[kind];
                return (
                  <Menu.Item
                    key={kind}
                    onSelect={() => {
                      onStyleChange({ shapeKind: kind });
                      onModeChange("shape");
                    }}
                  >
                    <KindIcon aria-hidden />
                    {t(`tools-annotate.shapes.${kind}`)}
                  </Menu.Item>
                );
              })}
            </Menu.Content>
          </Menu.Root>

          <ModeButton label={t("tools-annotate.toolbar.freeText")} active={mode === "freeText"} onClick={() => onModeChange("freeText")}>
            <FreeTextIcon />
          </ModeButton>

          <span className="mx-1 h-6 w-px bg-border" aria-hidden="true" />

          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <IconButton variant="danger" aria-label={t("tools-annotate.toolbar.delete")} disabled={!selectedAnnot} onClick={onDeleteSelected}>
                <DeleteIcon />
              </IconButton>
            </Tooltip.Trigger>
            <Tooltip.Content>{t("tools-annotate.toolbar.delete")}</Tooltip.Content>
          </Tooltip.Root>
        </div>

        <span className="h-8 w-px bg-border" aria-hidden="true" />

        <div aria-label={t("tools-annotate.style.ariaLabel")} className="flex flex-wrap items-center gap-3">
          <fieldset disabled={!colorEditable} className="flex items-center gap-1 disabled:opacity-40">
            <span className="text-xs font-medium text-muted-text">{t("tools-annotate.style.color")}</span>
            {COLOR_PRESETS.map((preset) => (
              <button
                key={preset}
                type="button"
                aria-label={preset}
                onClick={() => handleColorChange(preset)}
                className="h-6 w-6 rounded-full border border-border-strong"
                style={{ backgroundColor: preset, outline: colorValue.toLowerCase() === preset.toLowerCase() ? "2px solid var(--rubrica-accent)" : undefined, outlineOffset: 1 }}
              />
            ))}
            <input
              type="color"
              aria-label={t("tools-annotate.style.customColor")}
              value={colorValue}
              onChange={(event) => handleColorChange(event.target.value)}
              className="h-6 w-7 cursor-pointer rounded border border-border-strong bg-transparent p-0"
            />
          </fieldset>

          <div className="flex items-center gap-1.5">
            <label htmlFor={opacityId} className="text-xs font-medium text-muted-text">
              {t("tools-annotate.style.opacity")}
            </label>
            <input
              id={opacityId}
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacityValue}
              disabled={!opacityEditable}
              onChange={(event) => handleOpacityChange(Number(event.target.value))}
              className="w-24 disabled:opacity-40"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor={widthId} className="text-xs font-medium text-muted-text">
              {t("tools-annotate.style.width")}
            </label>
            <input
              id={widthId}
              type="range"
              min={1}
              max={16}
              step={1}
              value={style.strokeWidth}
              disabled={geometryOnlyEditable}
              onChange={(event) => onStyleChange({ strokeWidth: Number(event.target.value) })}
              className="w-20 disabled:opacity-40"
            />
          </div>

          <div className="flex items-center gap-1.5">
            <label htmlFor={fontSizeId} className="text-xs font-medium text-muted-text">
              {t("tools-annotate.style.fontSize")}
            </label>
            <input
              id={fontSizeId}
              type="number"
              min={8}
              max={72}
              value={style.fontSize}
              disabled={geometryOnlyEditable}
              onChange={(event) => onStyleChange({ fontSize: Number(event.target.value) })}
              className="w-14 rounded border border-border bg-surface px-1 py-0.5 text-sm text-text disabled:opacity-40"
            />
          </div>

          <Tooltip.Root>
            <Tooltip.Trigger asChild>
              <IconButton
                aria-label={t("tools-annotate.style.fill")}
                aria-pressed={style.filled}
                disabled={geometryOnlyEditable}
                onClick={() => onStyleChange({ filled: !style.filled })}
              >
                <FillIcon />
              </IconButton>
            </Tooltip.Trigger>
            <Tooltip.Content>{t("tools-annotate.style.fill")}</Tooltip.Content>
          </Tooltip.Root>
        </div>
      </div>
    </Tooltip.Provider>
  );
}

function ModeButton({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <IconButton aria-label={label} aria-pressed={active} onClick={onClick}>
          {children}
        </IconButton>
      </Tooltip.Trigger>
      <Tooltip.Content>{label}</Tooltip.Content>
    </Tooltip.Root>
  );
}
