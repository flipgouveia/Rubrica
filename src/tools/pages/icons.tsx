// Small hand-authored inline icon set for the pages tool. No icon library is
// installed in this repo (see package.json) and the brief doesn't call for
// adding one just for a handful of glyphs, so these are plain, minimal SVGs
// sized/colored via the parent IconButton's `[&_svg]:h-*` rules and
// `currentColor` (see tokens/components/IconButton.tsx). Purely decorative —
// every one of these is always paired with a caller-supplied `aria-label`.
import type { SVGProps } from "react";

function IconBase(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export function RotateLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M9 4.5H6a1.5 1.5 0 0 0-1.5 1.5v3" />
      <path d="M4.5 6 8 8.5" />
      <path d="M13 4.6a7.5 7.5 0 1 1-8.4 5.4" />
    </IconBase>
  );
}

export function RotateRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M15 4.5h3A1.5 1.5 0 0 1 19.5 6v3" />
      <path d="M19.5 6 16 8.5" />
      <path d="M11 4.6a7.5 7.5 0 1 0 8.4 5.4" />
    </IconBase>
  );
}

export function TrashIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M4.5 7h15" />
      <path d="M9 7V5.25A1.25 1.25 0 0 1 10.25 4h3.5A1.25 1.25 0 0 1 15 5.25V7" />
      <path d="M6.5 7 7.3 19a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7" />
      <path d="M10.25 10.5v6" />
      <path d="M13.75 10.5v6" />
    </IconBase>
  );
}

export function GripIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props} strokeWidth={0} fill="currentColor">
      <circle cx="9" cy="6" r="1.4" />
      <circle cx="15" cy="6" r="1.4" />
      <circle cx="9" cy="12" r="1.4" />
      <circle cx="15" cy="12" r="1.4" />
      <circle cx="9" cy="18" r="1.4" />
      <circle cx="15" cy="18" r="1.4" />
    </IconBase>
  );
}

export function CloseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <IconBase {...props}>
      <path d="M6 6l12 12" />
      <path d="M18 6 6 18" />
    </IconBase>
  );
}
