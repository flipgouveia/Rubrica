import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useOpeningStore } from "./openingStore";
import { OpeningOverlay } from "./OpeningOverlay";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

beforeEach(() => {
  useOpeningStore.setState({ paths: [] });
});

describe("OpeningOverlay", () => {
  it("renders nothing when no document is opening", () => {
    render(<OpeningOverlay />);
    expect(screen.queryByTestId("opening-overlay")).toBeNull();
  });

  it("shows the file name while a document is opening and hides when done", () => {
    render(<OpeningOverlay />);
    act(() => useOpeningStore.getState().begin("C:\\docs\\big file.pdf"));
    expect(screen.getByTestId("opening-overlay")).toBeTruthy();
    expect(screen.getByText("big file.pdf")).toBeTruthy();
    act(() => useOpeningStore.getState().end("C:\\docs\\big file.pdf"));
    expect(screen.queryByTestId("opening-overlay")).toBeNull();
  });
});
