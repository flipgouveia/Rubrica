// Settings → Pesquisa: the four highlight colours (same store as the search panel's chip palette);
// plus the accent-colour picker and closing the screen (back button / Escape return to where it was opened from).
import "../i18n";
import { cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAppViewStore } from "../chrome/appViewStore";
import { registerShortcut, useGlobalShortcuts } from "../chrome/shortcuts";
import { usePrefsStore } from "../chrome/prefsStore";
import { commands } from "../ipc";
import { useViewerStore } from "../viewer/store";
import { DEFAULT_HIGHLIGHT_COLORS } from "../viewer/search/searchColors";
import { resetSearchPrefsForTests, useSearchPrefs } from "../viewer/search/searchPrefs";
import { SettingsScreen } from "./SettingsScreen";

const prefs = () => useSearchPrefs.getState();
let user: ReturnType<typeof userEvent.setup>;

beforeEach(() => {
  localStorage.clear();
  resetSearchPrefsForTests();
  usePrefsStore.setState({ accentColor: "rubrica" });
  document.documentElement.removeAttribute("data-accent");
  useAppViewStore.setState({ view: "settings", previousView: "home" });
  useViewerStore.setState({ tabs: [], activeTabId: null });
  user = userEvent.setup();
});
afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-accent");
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

function section() {
  return screen.getByRole("region", { name: "Pesquisa" });
}

describe("Settings → Pesquisa", () => {
  it("has a 'Pesquisa' section with one editor per colour position and a reset", () => {
    render(<SettingsScreen />);
    const search = section();
    expect(within(search).getByText("Cores do destaque")).toBeInTheDocument();
    expect(within(search).getByText(/Uma cor por posição do termo/)).toBeInTheDocument();
    for (const n of [1, 2, 3, 4]) expect(within(search).getByRole("group", { name: `Cor ${n}` })).toBeInTheDocument();
    expect(within(search).getAllByRole("button", { name: /^Cor predefinida #/ })).toHaveLength(4 * 8);
    expect(within(search).getByRole("button", { name: "Repor cores originais" })).toBeInTheDocument();
  });

  it("edits one position with a preset, saves it, and shows the selection", async () => {
    render(<SettingsScreen />);
    const third = within(screen.getByRole("group", { name: "Cor 3" }));
    expect(third.getByRole("button", { name: "Cor predefinida #F472B6" })).toHaveAttribute("aria-pressed", "true");
    await user.click(third.getByRole("button", { name: "Cor predefinida #FB923C" }));
    expect(prefs().highlightColors).toEqual(["#FACC15", "#22D3EE", "#FB923C", "#4ADE80"]);
    expect(third.getByRole("button", { name: "Cor predefinida #FB923C" })).toHaveAttribute("aria-pressed", "true");
    expect(third.getByRole("button", { name: "Cor predefinida #F472B6" })).toHaveAttribute("aria-pressed", "false");
    const stored = await commands.prefsGet("search.highlightColors");
    expect(JSON.parse(stored.status === "ok" ? (stored.data as string) : "null")).toEqual(prefs().highlightColors);
  });

  it("takes a free hex with validation and a live preview", async () => {
    render(<SettingsScreen />);
    const first = within(screen.getByRole("group", { name: "Cor 1" }));
    const hex = first.getByLabelText("Cor em hexadecimal");
    await user.clear(hex);
    await user.type(hex, "#00ff7f");
    expect(prefs().highlightColors[0]).toBe("#00FF7F");
    expect(first.getByTestId("color-example").style.background).toBe("rgba(0, 255, 127, 0.5)");
    await user.clear(hex);
    await user.type(hex, "#00ff7");
    expect(first.getByRole("alert")).toHaveTextContent("Use o formato #RRGGBB.");
    expect(prefs().highlightColors[0]).toBe("#00FF7F");
  });

  it("resets all four to the originals", async () => {
    prefs().setHighlightColor(0, "#60A5FA");
    prefs().setHighlightColor(3, "#F87171");
    render(<SettingsScreen />);
    await user.click(screen.getByRole("button", { name: "Repor cores originais" }));
    expect(prefs().highlightColors).toEqual(DEFAULT_HIGHLIGHT_COLORS);
    const fourth = within(screen.getByRole("group", { name: "Cor 4" }));
    expect(fourth.getByRole("button", { name: "Cor predefinida #4ADE80" })).toHaveAttribute("aria-pressed", "true");
  });

  it("loads the saved colours when opened (the search panel may never have been mounted)", async () => {
    await commands.prefsSet("search.highlightColors", JSON.stringify(["#a78bfa", "#22d3ee", "#f472b6", "#4ade80"]));
    render(<SettingsScreen />);
    await waitFor(() => expect(prefs().highlightColors[0]).toBe("#A78BFA"));
    const first = within(screen.getByRole("group", { name: "Cor 1" }));
    expect(first.getByRole("button", { name: "Cor predefinida #A78BFA" })).toHaveAttribute("aria-pressed", "true");
  });

  it("is in English too", async () => {
    const { default: i18n } = await import("../i18n");
    await i18n.changeLanguage("en");
    try {
      render(<SettingsScreen />);
      const search = screen.getByRole("region", { name: "Search" });
      expect(within(search).getByText("Highlight colors")).toBeInTheDocument();
      expect(within(search).getByRole("button", { name: "Reset to original colors" })).toBeInTheDocument();
      expect(within(search).getByRole("group", { name: "Color 2" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("pt-PT");
    }
  });
});

describe("Settings → Cor de destaque", () => {
  const group = () => screen.getByRole("radiogroup", { name: "Cor de destaque" });

  it("is a radio group of the presets, the Rubrica red selected by default", () => {
    render(<SettingsScreen />);
    const radios = within(group()).getAllByRole("radio");
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(["rubrica", "blue", "teal", "green", "purple", "graphite"]);
    expect(within(group()).getByRole("radio", { name: "Vermelho Rubrica" })).toBeChecked();
    expect(within(group()).getByRole("radio", { name: "Azul" })).not.toBeChecked();
  });

  it("applies and saves the chosen preset (data-accent), and going back to the default removes it", async () => {
    render(<SettingsScreen />);
    await user.click(within(group()).getByRole("radio", { name: "Azul" }));
    expect(document.documentElement.getAttribute("data-accent")).toBe("blue");
    expect(usePrefsStore.getState().accentColor).toBe("blue");
    expect(within(group()).getByRole("radio", { name: "Azul" })).toBeChecked();
    const stored = await commands.prefsGet("ui.accentColor");
    expect(stored.status === "ok" ? stored.data : null).toBe("blue");
    await user.click(within(group()).getByRole("radio", { name: "Vermelho Rubrica" }));
    expect(document.documentElement.hasAttribute("data-accent")).toBe(false);
  });

  it("is keyboard operable: arrow keys move the choice along the group", async () => {
    render(<SettingsScreen />);
    within(group()).getByRole("radio", { name: "Vermelho Rubrica" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(document.documentElement.getAttribute("data-accent")).toBe("blue");
    expect(within(group()).getByRole("radio", { name: "Azul" })).toHaveFocus();
  });

  it("is in English too", async () => {
    const { default: i18n } = await import("../i18n");
    await i18n.changeLanguage("en");
    try {
      render(<SettingsScreen />);
      const english = screen.getByRole("radiogroup", { name: "Accent color" });
      expect(within(english).getByRole("radio", { name: "Teal" })).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage("pt-PT");
    }
  });
});

describe("closing Settings", () => {
  function openTab() {
    useViewerStore.setState({ tabs: [{} as never], activeTabId: null });
  }

  it("the back button returns to the open document when Settings was opened from the viewer", async () => {
    openTab();
    useAppViewStore.setState({ view: "settings", previousView: "viewer" });
    render(<SettingsScreen />);
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(useAppViewStore.getState().view).toBe("viewer");
  });

  it("the back button returns to Home when Settings was opened from Home", async () => {
    openTab();
    render(<SettingsScreen />);
    await user.click(screen.getByRole("button", { name: "Fechar" }));
    expect(useAppViewStore.getState().view).toBe("home");
  });

  it("Escape closes it the same way", async () => {
    openTab();
    useAppViewStore.setState({ view: "settings", previousView: "viewer" });
    render(<SettingsScreen />);
    await user.keyboard("{Escape}");
    expect(useAppViewStore.getState().view).toBe("viewer");
  });

  it("Escape in a text field (the colour hex input) does not close it", async () => {
    render(<SettingsScreen />);
    await user.click(within(screen.getByRole("group", { name: "Cor 1" })).getByLabelText("Cor em hexadecimal"));
    await user.keyboard("{Escape}");
    expect(useAppViewStore.getState().view).toBe("settings");
  });

  it("Escape still closes it with the global Escape shortcut mounted (it preventDefaults in the bubble phase)", async () => {
    openTab();
    useAppViewStore.setState({ view: "settings", previousView: "viewer" });
    const unregister = registerShortcut({ id: "test.clearSelection", keys: "escape", handler: () => {}, labelKey: "test" });
    // Mounted BEFORE Settings, like the app root, so its window listener runs first in the bubble phase.
    const globalShortcuts = renderHook(() => useGlobalShortcuts());
    render(<SettingsScreen />);
    await user.keyboard("{Escape}");
    expect(useAppViewStore.getState().view).toBe("viewer");
    unregister();
    globalShortcuts.unmount();
  });

  it("Escape while a dialog is open (the command palette) does not close it", async () => {
    render(
      <>
        <SettingsScreen />
        <div role="dialog" />
      </>,
    );
    await user.keyboard("{Escape}");
    expect(useAppViewStore.getState().view).toBe("settings");
  });
});
