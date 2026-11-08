// The single "pages are still rendering" wheel for a document. Sits over the viewer's top-right
// corner, outside the scroller. Invisible for the first 350ms (see .rubrica-tile-loading) so quick
// renders and zoom changes never flash it.
import { useTranslation } from "react-i18next";
import { useDocTilesLoading } from "./tileLoadingStore";

export function TileLoadingIndicator({ docId }: { docId: string }) {
  const { t } = useTranslation("common");
  const loading = useDocTilesLoading(docId);
  if (!loading) return null;
  return (
    <div
      className="rubrica-tile-loading absolute top-3 right-12 z-10 flex items-center gap-2 rounded-full border border-border bg-surface/95 px-3 py-1.5 shadow-md"
      role="status"
      data-testid="tile-loading-indicator"
    >
      <span className="rubrica-spinner h-4 w-4 rounded-full border-2 border-border-strong border-t-accent" aria-hidden="true" />
      <span className="text-xs text-muted-text">{t("common:common.status.rendering")}</span>
    </div>
  );
}
