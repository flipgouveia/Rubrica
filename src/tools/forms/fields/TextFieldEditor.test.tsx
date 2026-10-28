import "../../../i18n";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FormField } from "../../../ipc/bindings";
import { TextFieldEditor } from "./TextFieldEditor";

// The repo's vitest config doesn't enable jest-style implicit globals, so
// testing-library's own auto-cleanup (which detects a global `afterEach`)
// never registers — clean up explicitly so each `it()` starts from an empty
// DOM instead of accumulating every previous test's render.
afterEach(() => cleanup());

function textField(overrides: Partial<FormField> = {}): FormField {
  return {
    id: "field-name",
    page: 0,
    rect: { x: 0, y: 0, width: 100, height: 20 },
    kind: "text",
    value: "",
    options: null,
    readOnly: false,
    required: false,
    ...overrides,
  };
}

describe("TextFieldEditor", () => {
  it("commits the typed value and advances on Enter", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(<TextFieldEditor docId="doc-1" field={textField()} tabIndex={1} pending={false} onCommit={onCommit} />);

    const input = screen.getByRole("textbox");
    await user.type(input, "Ada Lovelace{Enter}");

    expect(onCommit).toHaveBeenCalledWith("Ada Lovelace", true);
  });

  it("commits on blur when the value changed, without advancing", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <>
        <TextFieldEditor docId="doc-1" field={textField()} tabIndex={1} pending={false} onCommit={onCommit} />
        <button type="button">elsewhere</button>
      </>,
    );

    const input = screen.getByRole("textbox");
    await user.type(input, "Grace Hopper");
    await user.click(screen.getByRole("button", { name: "elsewhere" }));

    expect(onCommit).toHaveBeenCalledWith("Grace Hopper", false);
  });

  it("marks required fields with aria-required and an accessible name that mentions it", () => {
    render(<TextFieldEditor docId="doc-1" field={textField({ required: true })} tabIndex={1} pending={false} onCommit={vi.fn()} />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("aria-required", "true");
    // i18n defaults to pt-PT (see src/i18n/index.ts's DEFAULT_LANGUAGE) — the
    // required-suffix key is "tools-forms.field.requiredSuffix" == ", obrigatório".
    expect(input.getAttribute("aria-label")).toMatch(/obrigatório/i);
  });

  it("read-only fields are non-interactive and never call onCommit", async () => {
    const user = userEvent.setup();
    const onCommit = vi.fn();
    render(
      <TextFieldEditor
        docId="doc-1"
        field={textField({ readOnly: true, value: "locked" })}
        tabIndex={1}
        pending={false}
        onCommit={onCommit}
      />,
    );

    const input = screen.getByRole("textbox");
    expect(input).toBeDisabled();
    expect(input).toHaveValue("locked");
    await user.type(input, "should not work{Enter}");

    expect(input).toHaveValue("locked");
    expect(onCommit).not.toHaveBeenCalled();
  });

  // Some real-engine field kinds' `form_set_value` can never actually
  // persist (see `engine::forms`'s module doc comment) — a rejected commit
  // must not leave the input looking like it kept the user's typed value,
  // since `field.value` itself never changes in that case.
  it("reverts the draft to the real value and shows a badge when a commit is rejected", async () => {
    const user = userEvent.setup();
    const field = textField({ value: "Ana Silva" });
    const { rerender } = render(<TextFieldEditor docId="doc-1" field={field} tabIndex={1} pending={false} onCommit={vi.fn()} />);

    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "Something else");
    expect(input).toHaveValue("Something else");

    // Simulate `FieldOverlay` learning the commit was rejected: `field`
    // itself is unchanged (the real engine never wrote anything), but an
    // `error` now arrives.
    rerender(<TextFieldEditor docId="doc-1" field={field} tabIndex={1} pending={false} error="not supported" onCommit={vi.fn()} />);

    await waitFor(() => expect(input).toHaveValue("Ana Silva"));
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});
