// requestAnimationFrame batching for pointer-move updates to an in-progress
// draw's SVG geometry. ARCHITECTURE: "the UI renders the in-progress object
// as SVG overlay at 60 fps" — the naive approach (call `setState` on every
// `pointermove`) can fire far more often than the display refreshes and
// forces React to re-render every time; this coalesces any number of
// updates that land within one frame into a single `setState` call, so the
// overlay updates at most once per animation frame no matter how chatty the
// input events are.
import { useCallback, useEffect, useRef, useState } from "react";

export function useRafBatch<T>(initial: T): [T, (value: T) => void, () => void] {
  const [value, setValue] = useState(initial);
  const initialRef = useRef(initial);
  const pendingRef = useRef<T | null>(null);
  const frameRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    frameRef.current = null;
    if (pendingRef.current !== null) {
      setValue(pendingRef.current);
      pendingRef.current = null;
    }
  }, []);

  const schedule = useCallback(
    (next: T) => {
      pendingRef.current = next;
      if (frameRef.current === null) {
        frameRef.current = requestAnimationFrame(flush);
      }
    },
    [flush],
  );

  const reset = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    pendingRef.current = null;
    setValue(initialRef.current);
  }, []);

  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return [value, schedule, reset];
}
