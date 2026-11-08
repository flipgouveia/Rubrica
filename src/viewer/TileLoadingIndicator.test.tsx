import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { TileLoadingIndicator } from "./TileLoadingIndicator";
import { useTileLoadingStore } from "./tileLoadingStore";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(() => {
  cleanup();
  useTileLoadingStore.setState({ pending: {} });
});

describe("TileLoadingIndicator", () => {
  it("shows a single indicator for however many tiles are pending, for its own document only", () => {
    render(<TileLoadingIndicator docId="d1" />);
    expect(screen.queryByTestId("tile-loading-indicator")).toBeNull();
    act(() => {
      useTileLoadingStore.getState().begin("d1");
      useTileLoadingStore.getState().begin("d1");
      useTileLoadingStore.getState().begin("d1");
    });
    expect(screen.getAllByTestId("tile-loading-indicator")).toHaveLength(1);
    act(() => {
      useTileLoadingStore.getState().end("d1");
      useTileLoadingStore.getState().end("d1");
      useTileLoadingStore.getState().end("d1");
    });
    expect(screen.queryByTestId("tile-loading-indicator")).toBeNull();
  });

  it("ignores tiles of other documents", () => {
    render(<TileLoadingIndicator docId="d1" />);
    act(() => useTileLoadingStore.getState().begin("d2"));
    expect(screen.queryByTestId("tile-loading-indicator")).toBeNull();
  });
});
