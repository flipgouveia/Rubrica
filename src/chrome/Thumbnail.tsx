// One rail thumbnail, resolved asynchronously against the mock's synthetic latency — same
// per-item-component pattern as src/viewer/Tile.tsx, for the same rules-of-hooks reason (the
// rail's item count is the whole document, but each item still needs its own load state).
import { useEffect, useState } from "react";
import { isMockEngine, mockThumbUrlAsync, realThumbUrl } from "../ipc";
import { TRANSPARENT_PIXEL } from "../viewer/blankPixel";
import type { DocId } from "../viewer/types";

interface ThumbnailProps {
  docId: DocId;
  page: number;
  revision: number;
  alt: string;
  className?: string;
}

export function Thumbnail({ docId, page, revision, alt, className }: ThumbnailProps) {
  const [src, setSrc] = useState<string | null>(() => (isMockEngine ? null : realThumbUrl(docId, page, revision)));

  useEffect(() => {
    if (!isMockEngine) {
      setSrc(realThumbUrl(docId, page, revision));
      return;
    }
    let cancelled = false;
    setSrc(null);
    void mockThumbUrlAsync(docId, page, revision).then((url) => {
      if (!cancelled) setSrc(url);
    });
    return () => {
      cancelled = true;
    };
  }, [docId, page, revision]);

  // `||`, not `??`: a canvas-less environment (jsdom in tests) makes the mock draw resolve to
  // `""` rather than throwing, which should fall back the same as "not loaded yet".
  return <img src={src || TRANSPARENT_PIXEL} alt={alt} draggable={false} className={className} />;
}
