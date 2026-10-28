import { useTranslation } from "react-i18next";
import type { PageViewport } from "../../chrome/tool-api";
import type { PageRect, Rect, SearchHit } from "../../ipc/bindings";
import { colorOf, highlightFill } from "./searchColors";
import { useSearchPrefs } from "./searchPrefs";
import { useSearchStore } from "./searchStore";

interface SearchHighlightsProps {
  page: number;
  viewport: PageViewport;
}

/** Soft padding (CSS px) around a proximity window so its outline does not touch the text. */
const WINDOW_PAD = 3;

function boundsOf(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    const x = rect.x ?? 0;
    const y = rect.y ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + (rect.width ?? 0));
    maxY = Math.max(maxY, y + (rect.height ?? 0));
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

const onPage = (rects: PageRect[], page: number): Rect[] => rects.filter((r) => r.page === page).map((r) => r.rect);

/**
 * Visual-only highlight layer for streamed search hits on one page. Hits are keyed by their START page,
 * so this page also draws the second half of a hit that began on the previous page (`spansPages`):
 * every rect is painted on its OWN `rect.page`. Per term position the colour is the user's
 * (`search.highlightColors`, ~50 % opacity); the active hit is outlined with `--search-active` on all
 * its rects (B2/B7, identity = the store's `(page, hitIndex)`), and a proximity window is a soft
 * rectangle around its `windowRects` (outlined for the active one). Header/footer lines the engine
 * excluded are dimmed and struck through.
 */
export function SearchHighlights({ page, viewport }: SearchHighlightsProps) {
  const { t } = useTranslation("viewer");
  const docId = viewport.docId;
  const own = useSearchStore((s) => s.byDoc[docId]?.hitsByPage[page]);
  const previous = useSearchStore((s) => s.byDoc[docId]?.hitsByPage[page - 1]);
  const active = useSearchStore((s) => s.byDoc[docId]?.active ?? null);
  const furniture = useSearchStore((s) => s.byDoc[docId]?.furniture[page]);
  const colors = useSearchPrefs((s) => s.highlightColors);

  // What is drawn on this page: the hits that start here, plus the tail of those that began on the
  // previous page (only hits that really continue onto this page are looked at).
  const drawn: { start: number; hitIndex: number; hit: SearchHit }[] = [];
  previous?.forEach((hit, hitIndex) => {
    if (hit.spansPages?.[1] === page || hit.rects.some((r) => r.page === page)) drawn.push({ start: page - 1, hitIndex, hit });
  });
  own?.forEach((hit, hitIndex) => drawn.push({ start: page, hitIndex, hit }));
  if (drawn.length === 0 && (!furniture || furniture.length === 0)) return null;

  const px = (rect: Rect, pad = 0) => {
    const topLeft = viewport.toScreen(rect.x ?? 0, (rect.y ?? 0) + (rect.height ?? 0));
    return {
      left: topLeft.x - pad,
      top: topLeft.y - pad,
      width: (rect.width ?? 0) * viewport.zoom + 2 * pad,
      height: (rect.height ?? 0) * viewport.zoom + 2 * pad,
    };
  };

  return (
    <div className="pointer-events-none absolute inset-0">
      {(furniture ?? []).map((rect, i) => (
        <div
          key={`furniture-${i}`}
          data-search-furniture=""
          title={t("viewer.search.furnitureIgnored")}
          className="absolute"
          style={{ ...px(rect), background: "rgb(255 255 255 / 0.65)" }}
        >
          <div className="absolute inset-x-0 top-1/2 h-px" style={{ background: "rgb(36 28 26 / 0.55)" }} />
        </div>
      ))}
      {drawn.map(({ start, hitIndex, hit }) => {
        const isActive = active !== null && active.page === start && active.hitIndex === hitIndex;
        const windowBox = boundsOf(onPage(hit.windowRects, page));
        const rects = hit.rects.filter((r) => r.page === page);
        if (!windowBox && rects.length === 0) return null;
        return (
          <div key={`${start}-${hitIndex}`} data-search-hit="" data-active={isActive ? "true" : undefined}>
            {windowBox && (
              <div
                data-search-window=""
                data-active={isActive ? "true" : undefined}
                className="absolute rounded-[4px]"
                style={{
                  ...px(windowBox, WINDOW_PAD),
                  background: "var(--search-window)",
                  boxShadow: isActive ? "0 0 0 1.5px var(--search-window-line)" : undefined,
                }}
              />
            )}
            {rects.map(({ rect, term }, i) => (
              <div
                key={i}
                data-search-rect=""
                data-term={term}
                data-color={colorOf(colors, term)}
                data-active={isActive ? "true" : undefined}
                className="absolute rounded-[2px]"
                style={{
                  ...px(rect),
                  background: highlightFill(colors, term),
                  outline: isActive ? "2px solid var(--search-active)" : undefined,
                  outlineOffset: isActive ? 1 : undefined,
                }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
