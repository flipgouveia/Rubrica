// Mouse side buttons: button 3 is "back", button 4 is "forward" (MouseEvent.button). Without this
// WebView2 would try to walk its own (empty) page history, so the buttons did nothing in Rubrica.
// We also swallow the matching mousedown/auxclick so the webview never starts its own navigation.
import { useEffect } from "react";
import { useAppViewStore } from "./appViewStore";

const BACK_BUTTON = 3;
const FORWARD_BUTTON = 4;

export function handleMouseNavigation(event: MouseEvent): void {
  if (event.button !== BACK_BUTTON && event.button !== FORWARD_BUTTON) return;
  event.preventDefault();
  // Act once per click: on release, like browsers do.
  if (event.type !== "mouseup") return;
  const store = useAppViewStore.getState();
  if (event.button === BACK_BUTTON) store.historyBack();
  else store.historyForward();
}

export function useMouseNavigation(): void {
  useEffect(() => {
    const types = ["mousedown", "mouseup", "auxclick"] as const;
    for (const type of types) window.addEventListener(type, handleMouseNavigation);
    return () => {
      for (const type of types) window.removeEventListener(type, handleMouseNavigation);
    };
  }, []);
}
