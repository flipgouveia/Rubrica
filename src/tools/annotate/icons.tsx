// Small hand-rolled icon set for the annotation toolbar. No icon library is
// in the dependency list yet (CONTRACTS §10: additions beyond a brief's
// explicit list go in the report) — these are plain inline SVGs, styled via
// `currentColor` so they inherit `IconButton`'s text color (including its
// `aria-pressed` accent state), same pattern any icon-library icon would
// follow. Purely decorative inside an `IconButton`/`Tooltip` pair that
// already carries the accessible name, so every icon here is `aria-hidden`.
import type { SVGProps } from "react";

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  );
}

export function SelectIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 3l6.5 16.5 2-6.7 6.5-2L5 3z" fill="currentColor" stroke="none" />
    </Icon>
  );
}

export function HighlightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 18h16" />
      <rect x="5" y="6" width="14" height="8" rx="1" fill="currentColor" fillOpacity={0.35} stroke="none" />
      <path d="M5 6h14v8H5z" />
    </Icon>
  );
}

export function UnderlineIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M6 4v7a6 6 0 0 0 12 0V4" />
      <path d="M4 20h16" />
    </Icon>
  );
}

export function StrikeoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M7 5h6a3.5 3.5 0 0 1 3.2 4.9" />
      <path d="M8.6 18.9A3.5 3.5 0 0 0 12 19.5h1" />
      <path d="M4 12h16" />
    </Icon>
  );
}

export function InkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M4 19c3-1 4-3 5-6s2-8 5-9 4 3 2 6-6 3-8 6-2 5-4 4 0-1 0-1z" />
    </Icon>
  );
}

export function NoteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M16 4v3h3" />
      <path d="M8 11h8M8 15h5" />
    </Icon>
  );
}

export function RectShapeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="4" y="6" width="16" height="12" rx="1.5" />
    </Icon>
  );
}

export function EllipseShapeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <ellipse cx="12" cy="12" rx="8" ry="6" />
    </Icon>
  );
}

export function LineShapeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 19L19 5" />
    </Icon>
  );
}

export function ArrowShapeIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 19L19 5" />
      <path d="M10 5h9v9" />
    </Icon>
  );
}

export function FreeTextIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 6h14" />
      <path d="M12 6v13" />
      <path d="M9 19h6" />
    </Icon>
  );
}

export function DeleteIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <path d="M5 7h14" />
      <path d="M9 7V5h6v2" />
      <path d="M7 7l1 13h8l1-13" />
    </Icon>
  );
}

export function FillIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <Icon {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" fillOpacity={0.4} />
    </Icon>
  );
}
