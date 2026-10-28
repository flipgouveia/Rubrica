import "../../../i18n";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormField } from "../../../ipc/bindings";
import { RadioFieldEditor } from "./RadioFieldEditor";

// See TextFieldEditor.test.tsx: the repo's vitest config has no implicit
// globals, so testing-library's auto-cleanup never registers on its own.
afterEach(() => cleanup());

function radioField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-plan",
    page: 0,
    rect: { x: 0, y: 0, width: 200, height: 80 },
    kind: "radio",
    value: "",
    options: ["Basic", "Pro", "Enterprise"],
    readOnly: false,
    required: true,
    ...overrides,
  };
}

describe("RadioFieldEditor", () => {
  it("renders exactly one radio input per option, labeled with the option text — no free-text alternative exists", () => {
    render(<RadioFieldEditor docId="doc-1" field={radioField()} tabIndex={1} pending={false} onCommit={vi.fn()} />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    for (const option of ["Basic", "Pro", "Enterprise"]) {
      expect(screen.getByLabelText(option)).toBeInTheDocument();
    }
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("picking an option calls onCommit with that option's exact string, unchanged", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<RadioFieldEditor docId="doc-1" field={radioField()} tabIndex={1} pending={false} onCommit={onCommit} />);

    await user.click(screen.getByLabelText("Pro"));

    expect(onCommit).toHaveBeenCalledWith("Pro", false);
  });

  it("is a real, structural radio group — arrow keys move the native selection among only the given options", async () => {
    const user = userEvent.setup();
    render(<RadioFieldEditor docId="doc-1" field={radioField({ value: "Basic" })} tabIndex={1} pending={false} onCommit={vi.fn()} />);

    screen.getByLabelText("Basic").focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByLabelText("Pro")).toHaveFocus();
  });

  it("read-only radio groups are non-interactive and never call onCommit", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <RadioFieldEditor
        docId="doc-1"
        field={radioField({ readOnly: true, value: "Pro" })}
        tabIndex={1}
        pending={false}
        onCommit={onCommit}
      />,
    );

    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toBeDisabled();
    }
    await user.click(screen.getByLabelText("Enterprise"));

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Pro")).toBeChecked();
  });
});
