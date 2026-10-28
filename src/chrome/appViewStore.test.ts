// Settings remembers where it was opened from, so closing it returns there (not always to Home).
import { beforeEach, describe, expect, it } from "vitest";
import { useViewerStore } from "../viewer/store";
import { useAppViewStore } from "./appViewStore";

const app = () => useAppViewStore.getState();

function setOpenTabs(count: number) {
  useViewerStore.setState({ tabs: Array.from({ length: count }, () => ({}) as never), activeTabId: null });
}

beforeEach(() => {
  useAppViewStore.setState({ view: "home", previousView: "home" });
  setOpenTabs(0);
});

describe("appViewStore.goBack", () => {
  it("returns to the viewer when Settings was opened from it", () => {
    setOpenTabs(1);
    app().navigate("viewer");
    app().navigate("settings");
    expect(app().view).toBe("settings");
    app().goBack();
    expect(app().view).toBe("viewer");
  });

  it("returns to Home when Settings was opened from Home, even with documents open in the background", () => {
    setOpenTabs(2);
    app().navigate("home");
    app().navigate("settings");
    app().goBack();
    expect(app().view).toBe("home");
  });

  it("falls back to Home when every tab was closed meanwhile", () => {
    setOpenTabs(1);
    app().navigate("viewer");
    app().navigate("settings");
    setOpenTabs(0);
    app().goBack();
    expect(app().view).toBe("home");
  });

  it("keeps the original origin when Settings is navigated to again while showing (command palette)", () => {
    setOpenTabs(1);
    app().navigate("viewer");
    app().navigate("settings");
    app().navigate("settings");
    app().goBack();
    expect(app().view).toBe("viewer");
  });

  it("uses the latest origin on a second visit", () => {
    setOpenTabs(1);
    app().navigate("viewer");
    app().navigate("settings");
    app().navigate("home"); // e.g. "go home" from the command palette while in Settings
    app().navigate("settings");
    app().goBack();
    expect(app().view).toBe("home");
  });
});
