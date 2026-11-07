// Full-window "opening document" indicator, shown while a (possibly huge) PDF is being parsed.
// It blocks clicks underneath so the same file can't be opened twice by impatient double clicks.
import { useTranslation } from "react-i18next";
import { basename } from "./openDocument";
import { useOpeningStore } from "./openingStore";

export function OpeningOverlay() {
  const { t } = useTranslation("chrome");
  const path = useOpeningStore((s) => s.paths[0]);
  if (!path) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
      role="status"
      aria-live="polite"
      data-testid="opening-overlay"
    >
      <div className="flex max-w-md flex-col items-center gap-4 rounded-lg border border-border bg-surface px-8 py-6 shadow-lg">
        <span className="rubrica-spinner h-8 w-8 rounded-full border-[3px] border-border-strong border-t-accent" aria-hidden="true" />
        <div className="text-center">
          <p className="text-sm font-medium text-text">{t("chrome:chrome.opening.title")}</p>
          <p className="mt-1 max-w-80 truncate text-xs text-muted-text" title={basename(path)}>
            {basename(path)}
          </p>
        </div>
      </div>
    </div>
  );
}
