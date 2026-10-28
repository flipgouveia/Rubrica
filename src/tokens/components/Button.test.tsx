import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./Button";

describe("Button", () => {
  it("renders its children and defaults to a native, non-submitting button", () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("type", "button");
  });

  it("calls onClick when activated and stays inert while disabled", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();

    render(
      <Button onClick={onClick} disabled>
        Delete
      </Button>,
    );
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("renders as its single child via asChild instead of wrapping in a <button>", () => {
    render(
      <Button asChild>
        <a href="/recents">Recents</a>
      </Button>,
    );
    const link = screen.getByRole("link", { name: "Recents" });
    expect(link).toBeInTheDocument();
    expect(link).not.toHaveAttribute("type");
  });
});
