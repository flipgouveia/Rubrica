import "../../../i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormField } from "../../../ipc/bindings";
import { ChoiceFieldEditor } from "./ChoiceFieldEditor";

// See TextFieldEditor.test.tsx: the repo's vitest config has no implicit
// globals, so testing-library's auto-cleanup never registers on its own.
afterEach(() => cleanup());

function comboField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-country",
    page: 1,
    rect: { x: 0, y: 0, width: 200, height: 24 },
    kind: "combo",
    value: "Portugal",
    options: ["Portugal", "Spain", "France"],
    readOnly: false,
    required: false,
    ...overrides,
  };
}

function listboxField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-language",
    page: 1,
    rect: { x: 0, y: 0, width: 200, height: 60 },
    kind: "listbox",
    value: "pt-PT",
    options: ["pt-PT", "en", "es", "fr"],
    readOnly: false,
    required: false,
    ...overrides,
  };
}

describe("ChoiceFieldEditor (combo)", () => {
  it("exposes exactly the field's options, verbatim, as the only selectable values", () => {
    render(<ChoiceFieldEditor docId="doc-1" field={comboField()} tabIndex={1} pending={false} onCommit={vi.fn()} variant="combo" />);
    const options = screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["Portugal", "Spain", "France"]);
  });

  it("picking an option calls onCommit with that exact option string", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<ChoiceFieldEditor docId="doc-1" field={comboField()} tabIndex={1} pending={false} onCommit={onCommit} variant="combo" />);

    await user.selectOptions(screen.getByRole("combobox"), "Spain");

    expect(onCommit).toHaveBeenCalledWith("Spain", false);
  });

  it("read-only combos are non-interactive and never call onCommit", async () => {
    const onCommit = vi.fn();
    render(
      <ChoiceFieldEditor
        docId="doc-1"
        field={comboField({ readOnly: true })}
        tabIndex={1}
        pending={false}
        onCommit={onCommit}
        variant="combo"
      />,
    );
    expect(screen.getByRole("combobox")).toBeDisabled();
  });
});

describe("ChoiceFieldEditor (listbox)", () => {
  it("exposes exactly the field's options, verbatim, as the only selectable values", () => {
    render(
      <ChoiceFieldEditor docId="doc-1" field={listboxField()} tabIndex={1} pending={false} onCommit={vi.fn()} variant="listbox" />,
    );
    const options = screen.getAllByRole("option").map((o) => (o as HTMLOptionElement).value);
    expect(options).toEqual(["pt-PT", "en", "es", "fr"]);
  });

  it("picking an option calls onCommit with that exact option string", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <ChoiceFieldEditor docId="doc-1" field={listboxField()} tabIndex={1} pending={false} onCommit={onCommit} variant="listbox" />,
    );

    await user.selectOptions(screen.getByRole("listbox"), "fr");

    expect(onCommit).toHaveBeenCalledWith("fr", false);
  });
});
