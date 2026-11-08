import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Tile } from "./Tile";
import { TRANSPARENT_PIXEL } from "./blankPixel";
import { useTileLoadingStore } from "./tileLoadingStore";

// The real mock draws on a canvas via `document` asynchronously, which can outlive the test
// environment. Resolve to "" at once (the canvas-less result), so the tile keeps its stand-in pixel.
vi.mock("../ipc", () => ({
  isMockEngine: true,
  mockTileUrlAsync: () => Promise.resolve(""),
  realTileUrl: () => "",
}));

const props = { docId: "d1", page: 0, bucket: 1, x: 0, y: 0, revision: 0, scale: 1 };
const pending = () => useTileLoadingStore.getState().pending["d1"] ?? 0;

afterEach(() => {
  cleanup();
  useTileLoadingStore.setState({ pending: {} });
});

describe("Tile loading registration", () => {
  it("counts as pending while loading, and the stand-in pixel's own load does not settle it", () => {
    const { container } = render(<Tile {...props} />);
    const img = container.querySelector("img") as HTMLImageElement;
    // jsdom has no canvas, so the mock render resolves to "" and the tile keeps the stand-in pixel.
    expect(img.getAttribute("src")).toBe(TRANSPARENT_PIXEL);
    expect(pending()).toBe(1);
    act(() => {
      fireEvent.load(img);
    });
    expect(pending()).toBe(1);
  });

  it("stops counting when the tile fails to load, so the wheel never spins forever", () => {
    const { container } = render(<Tile {...props} />);
    act(() => {
      fireEvent.error(container.querySelector("img") as HTMLImageElement);
    });
    expect(pending()).toBe(0);
  });

  it("releases its pending slot when unmounted mid-load", () => {
    const { unmount } = render(<Tile {...props} />);
    expect(pending()).toBe(1);
    unmount();
    expect(pending()).toBe(0);
  });

  it("many tiles share one counter", () => {
    render(
      <>
        <Tile {...props} x={0} />
        <Tile {...props} x={1} />
        <Tile {...props} x={2} />
      </>,
    );
    expect(pending()).toBe(3);
  });
});
