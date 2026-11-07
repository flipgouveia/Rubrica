import { beforeEach, describe, expect, it } from "vitest";
import { useViewerStore } from "../viewer/store";
import { useAppViewStore } from "./appViewStore";
import { handleMouseNavigation } from "./useMouseNavigation";

function fire(type: string, button: number): MouseEvent {
  const event = new MouseEvent(type, { button, cancelable: true });
  handleMouseNavigation(event);
  return event;
}

beforeEach(() => {
  useViewerStore.setState({ tabs: [{} as never], activeTabId: null });
  useAppViewStore.setState({ view: "home", previousView: "home", backStack: [], forwardStack: [] });
});

describe("handleMouseNavigation", () => {
  it("steps back on the back button and forward on the forward button", () => {
    useAppViewStore.getState().navigate("viewer");
    useAppViewStore.getState().navigate("home");
    fire("mouseup", 3);
    expect(useAppViewStore.getState().view).toBe("viewer");
    fire("mouseup", 4);
    expect(useAppViewStore.getState().view).toBe("home");
  });

  it("blocks the webview's own navigation but only acts on release", () => {
    useAppViewStore.getState().navigate("viewer");
    const down = fire("mousedown", 3);
    expect(down.defaultPrevented).toBe(true);
    expect(useAppViewStore.getState().view).toBe("viewer");
  });

  it("ignores the regular buttons", () => {
    useAppViewStore.getState().navigate("viewer");
    const event = fire("mouseup", 0);
    expect(event.defaultPrevented).toBe(false);
    expect(useAppViewStore.getState().view).toBe("viewer");
  });
});
