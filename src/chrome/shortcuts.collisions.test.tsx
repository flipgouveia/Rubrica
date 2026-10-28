// Keyboard & i18n audit (R8 deliverable 5 / CONTRACTS §7: "shortcuts registered through one
// central map"): `registerShortcut` already does a DEV-ONLY `console.error` on a same-scope
// "always" collision (see shortcuts.ts), but that's not CI-enforced — this test makes it a real,
// asserted check instead of a warning someone can scroll past.
//
// ".tsx" (not ".ts"): a static import of the 5 tool packages only reproduces each tool's
// "activate" shortcut (registered as an import side effect of `registerTool`, see each
// `tools/*/index.ts`) — it says nothing about the chrome-level "always" shortcuts registered
// imperatively inside React effects: Toolbar.tsx (ctrl+s/z/y/p, gated on a doc being open),
// CommandPalette.tsx (ctrl+k), SearchPanel.tsx (ctrl+f, only rendered once a doc is open), and
// useSelectionShortcuts.ts (ctrl+c, ctrl+a, shift+arrowleft/right, escape, mounted unconditionally
// by AppShell). The only way to exercise the real registration code for all of those together is
// to render the real component tree with a document open, exactly like
// `src/test/integration.test.tsx` already does — so this test reuses that same "open the mock
// sample doc" flow rather than re-typing each combo by hand (which would just be asserting the
// test's own copy of the strings against itself, and wouldn't catch a real collision introduced
// in application code).
import "../i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import App from "../App";
import { useViewerStore } from "../viewer/store";
import { listShortcuts } from "./shortcuts";

afterEach(() => {
  cleanup();
  useViewerStore.setState({ tabs: [], activeTabId: null });
});

describe("registered shortcut collisions", () => {
  it('has at most one "always"-scope handler per normalized key combo', async () => {
    const user = userEvent.setup();
    render(<App />);

    // Mounts Toolbar + SearchPanel (their "always" shortcuts only register once a tab is open —
    // see Toolbar.tsx's `if (!docId) return undefined` guard and AppShell's
    // `activeTabId && <SearchPanel .../>`). CommandPalette and useSelectionShortcuts are mounted
    // unconditionally by AppShell regardless of whether a doc is open, and all 5 tool packages
    // register their "activate" shortcut as an import side effect of App.tsx itself — so nothing
    // further is needed for those.
    const openButton = await screen.findByRole("button", { name: "Documento de texto de exemplo" });
    await user.click(openButton);
    await screen.findByRole("tab", { name: /demo-text\.pdf/ });

    const idsByCombo = new Map<string, string[]>();
    for (const entry of listShortcuts()) {
      if (entry.scope !== "always") continue;
      const ids = idsByCombo.get(entry.keys) ?? [];
      ids.push(entry.id);
      idsByCombo.set(entry.keys, ids);
    }

    const collisions = Array.from(idsByCombo.entries()).filter(([, ids]) => ids.length > 1);
    expect(collisions, `duplicate "always"-scope key combo(s): ${JSON.stringify(collisions)}`).toEqual([]);

    // Guards against this test passing vacuously (e.g. a broken mock/import silently leaving the
    // registry empty would make the assertion above trivially true). At the time of writing there
    // are 11 chrome-level "always" shortcuts (save/undo/redo/print/command-palette/search/copy/
    // select-page/extend-left/extend-right/clear-selection) plus 5 tool "activate" shortcuts, plus
    // the search v2 additions that are "always"-scope (Ctrl+Shift+F, F3, Shift+F3, Alt+P).
    expect(idsByCombo.size).toBeGreaterThanOrEqual(20);
  });

  it("registers the search shortcuts (B8) on their own, non-colliding combos", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Documento de texto de exemplo" }));
    await screen.findByRole("tab", { name: /demo-text\.pdf/ });

    const byId = new Map(listShortcuts().map((entry) => [entry.id, entry]));
    expect(byId.get("viewer.search.open")?.keys).toBe("ctrl+f");
    expect(byId.get("viewer.search.openPanel")?.keys).toBe("ctrl+shift+f");
    expect(byId.get("viewer.search.next")?.keys).toBe("f3");
    expect(byId.get("viewer.search.previous")?.keys).toBe("shift+f3");
    expect(byId.get("viewer.search.toggleMode")?.keys).toBe("alt+p");
    expect(byId.get("viewer.search.toggleMode")?.scope).toBe("always");
    // Escape is shared on purpose with "clear selection" (both fire); the search one is not "always".
    expect(byId.get("viewer.search.close")?.keys).toBe("escape");
    expect(byId.get("viewer.selection.clear")?.keys).toBe("escape");
    expect(byId.get("viewer.search.close")?.scope).not.toBe("always");

    // No other shortcut, of any scope, may share a search combo other than the deliberate Escape pair.
    const searchCombos = ["ctrl+f", "ctrl+shift+f", "f3", "shift+f3", "alt+p"];
    for (const combo of searchCombos) {
      const owners = listShortcuts().filter((entry) => entry.keys === combo);
      expect(owners.map((entry) => entry.id), `owners of ${combo}`).toHaveLength(1);
    }
  });
});
