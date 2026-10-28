// App preferences: the accent colour (`ui.accentColor`) defaults to the Rubrica red, persists, and is
// applied as the `data-accent` attribute (tokens.css holds the per-theme values for each preset).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "../ipc";
import { usePrefsStore } from "./prefsStore";

const prefs = () => usePrefsStore.getState();
const accentAttr = () => document.documentElement.getAttribute("data-accent");

async function stored(key: string) {
  const result = await commands.prefsGet(key);
  return result.status === "ok" ? result.data : undefined;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-accent");
  usePrefsStore.setState({ accentColor: "rubrica", loaded: false });
});
afterEach(() => {
  document.documentElement.removeAttribute("data-accent");
});

describe("prefsStore accent colour", () => {
  it("defaults to the Rubrica red and sets no attribute, so nothing changes for existing users", async () => {
    expect(prefs().accentColor).toBe("rubrica");
    await prefs().load();
    expect(prefs().accentColor).toBe("rubrica");
    expect(accentAttr()).toBeNull();
  });

  it("applies and persists a preset under ui.accentColor", async () => {
    prefs().setAccentColor("blue");
    expect(prefs().accentColor).toBe("blue");
    expect(accentAttr()).toBe("blue");
    expect(await stored("ui.accentColor")).toBe("blue");
  });

  it("choosing the default again removes the attribute", () => {
    prefs().setAccentColor("teal");
    prefs().setAccentColor("rubrica");
    expect(accentAttr()).toBeNull();
  });

  it("restores the saved preset on load", async () => {
    await commands.prefsSet("ui.accentColor", "purple");
    await prefs().load();
    expect(prefs().accentColor).toBe("purple");
    expect(accentAttr()).toBe("purple");
  });

  it("reads an unknown saved id back as the default", async () => {
    await commands.prefsSet("ui.accentColor", "hotpink");
    await prefs().load();
    expect(prefs().accentColor).toBe("rubrica");
    expect(accentAttr()).toBeNull();
  });
});
