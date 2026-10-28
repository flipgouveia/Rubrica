// The "hidden print window" (brief item 4): a detached, zero-size <iframe> loaded with one
// <img> per selected page and told to print itself, then torn down after `afterprint`. Built
// with DOM APIs (not `doc.write(templateString)`) so nothing here ever concatenates untrusted
// text into HTML.
import { isMockEngine, mockTileUrl } from "../../ipc";
import { realPrintUrl } from "../../ipc/protocolUrl";
import type { DocId } from "../../viewer/types";

const PRINT_PREVIEW_BUCKET = 2;
// Rasterised pages are PNGs of a few MB each; a long document legitimately takes a while to
// decode, so this only bounds a hang, it is not the normal path.
const IMAGES_READY_TIMEOUT_MS = 30_000;
// Fallback only: `afterprint` is what normally tears the iframe down. This is long on purpose —
// the system print dialog may stay open for minutes and reads the iframe's images while it does.
const CLEANUP_TIMEOUT_MS = 10 * 60_000;

/** Resolves once every image has decoded (`"ready"`), one failed (`"failed"`), or the wait timed out (`"timeout"`). */
function waitForImages(images: HTMLImageElement[]): Promise<"ready" | "failed" | "timeout"> {
  const decoded = Promise.all(images.map((img) => img.decode())).then(
    () => "ready" as const,
    () => "failed" as const,
  );
  const timeout = new Promise<"timeout">((resolve) => window.setTimeout(() => resolve("timeout"), IMAGES_READY_TIMEOUT_MS));
  return Promise.race([decoded, timeout]);
}

/**
 * Builds the hidden iframe, waits until every page image has decoded, then opens the print
 * dialog. Printing before the images load is what made pages come out blank, so `print()` is
 * never called ahead of that. Resolves `false` (nothing printed, iframe removed) when a page
 * image could not be loaded.
 */
export async function openPrintWindow(docId: DocId, pages: number[], revision: number, dpi: number): Promise<boolean> {
  const iframe = document.createElement("iframe");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  document.body.appendChild(iframe);

  const cleanup = () => {
    if (iframe.parentNode) document.body.removeChild(iframe);
  };

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  if (!doc || !win) {
    cleanup();
    return false;
  }

  doc.open();
  doc.write("<!doctype html><html><head></head><body></body></html>");
  doc.close();

  const style = doc.createElement("style");
  style.textContent = "@page { margin: 0; } html, body { margin: 0; padding: 0; } img { display: block; width: 100%; page-break-after: always; }";
  doc.head.appendChild(style);

  const images = pages.map((page) => {
    const img = doc.createElement("img");
    // Mock mode has no real filesystem, so it substitutes a placeholder tile — see
    // fixtures/README.md-style seam comments elsewhere (mockTileUrl) for the same pattern.
    img.src = isMockEngine ? mockTileUrl(docId, page, PRINT_PREVIEW_BUCKET, 0, 0, revision) : realPrintUrl(docId, page, dpi);
    doc.body.appendChild(img);
    return img;
  });

  const outcome = await waitForImages(images);
  if (outcome === "failed") {
    cleanup();
    return false;
  }

  win.addEventListener("afterprint", cleanup);
  window.setTimeout(cleanup, CLEANUP_TIMEOUT_MS);
  win.focus();
  win.print();
  return true;
}
