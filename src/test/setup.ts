import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement these; several dependencies exercised by this test suite need them
// (ViewerSurface/ThumbnailRail's `ResizeObserver`, Radix's pointer-capture calls on interactive
// primitives like Dialog/Menu). Stub, don't fully polyfill — tests assert on app state/DOM
// structure, not on real layout measurements or pointer capture semantics.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

if (!("ResizeObserver" in globalThis)) {
  Object.defineProperty(globalThis, "ResizeObserver", { writable: true, value: ResizeObserverStub });
}

for (const method of ["hasPointerCapture", "setPointerCapture", "releasePointerCapture"] as const) {
  if (!(method in Element.prototype)) {
    Object.defineProperty(Element.prototype, method, { writable: true, value: () => false });
  }
}

if (!Element.prototype.scrollIntoView) {
  Object.defineProperty(Element.prototype, "scrollIntoView", { writable: true, value: () => {} });
}

// jsdom never runs real layout, so every element measures 0x0 — @tanstack/react-virtual then
// computes an empty visible range (a 0-tall viewport contains nothing) and virtualizes away
// every page/thumbnail row, which would make ViewerSurface/ThumbnailRail untestable through the
// DOM. Give every element a plausible fixed viewport size instead, so the virtualizer renders a
// realistic first window of rows the same way it would in a real browser.
Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 1200 });
Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, value: 800 });
Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 1200 });
Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 800 });
Element.prototype.getBoundingClientRect = () =>
  ({ x: 0, y: 0, width: 1200, height: 800, top: 0, left: 0, right: 1200, bottom: 800, toJSON: () => {} }) as DOMRect;

// jsdom has no real canvas backend (installing the native `canvas` package just for tests isn't
// worth the native-build cost for a project that otherwise has zero native JS dependencies) —
// its real `getContext` logs a noisy "not implemented" console.error on every call. The mock
// tile/thumbnail renderer (src/ipc/mock/render.ts) already degrades to `""` on a null context,
// so short-circuit straight to that instead of routing through jsdom's unimplemented stub.
HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
