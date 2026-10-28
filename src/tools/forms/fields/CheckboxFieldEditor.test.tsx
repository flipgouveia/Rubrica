import "../../../i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormField } from "../../../ipc/bindings";
import { CheckboxFieldEditor } from "./CheckboxFieldEditor";

// See TextFieldEditor.test.tsx: the repo's vitest config has no implicit
// globals, so testing-library's auto-cleanup never registers on its own.
afterEach(() => cleanup());

function checkboxField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-subscribe",
    page: 0,
    rect: { x: 0, y: 0, width: 20, height: 20 },
    kind: "checkbox",
    value: "Off",
    options: null,
    readOnly: false,
    required: false,
    ...overrides,
  };
}

describe("CheckboxFieldEditor", () => {
  it("toggling on calls onCommit with the PDF On/Off convention, not booleans", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<CheckboxFieldEditor docId="doc-1" field={checkboxField()} tabIndex={1} pending={false} onCommit={onCommit} />);

    await user.click(screen.getByRole("checkbox"));

    expect(onCommit).toHaveBeenCalledWith("On", false);
  });

  it("toggling off from a checked field calls onCommit with Off", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<CheckboxFieldEditor docId="doc-1" field={checkboxField({ value: "On" })} tabIndex={1} pending={false} onCommit={onCommit} />);

    await user.click(screen.getByRole("checkbox"));

    expect(onCommit).toHaveBeenCalledWith("Off", false);
  });

  it("read-only checkboxes are non-interactive and never call onCommit", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <CheckboxFieldEditor
        docId="doc-1"
        field={checkboxField({ readOnly: true, value: "On" })}
        tabIndex={1}
        pending={false}
        onCommit={onCommit}
      />,
    );

    const checkbox = screen.getByRole("checkbox");
    expect(checkbox).toBeDisabled();
    await user.click(checkbox);

    expect(checkbox).toBeChecked();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
