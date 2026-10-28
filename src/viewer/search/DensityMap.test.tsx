// Density map component tests with the search selectors and the outline mocked (the real
// round-trip against the mock engine is in DensityMap.integration.test.tsx).
// jsdom has no layout: every element measures 1200x800 (src/test/setup.ts), so the track is 800px tall.
import "../../i18n";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlineItem, PageSize } from "../../ipc/bindings";
import type { OutlineState } from "../outline/outlineStore";
import { VIEWER_PADDING, VIEWER_PAGE_GAP } from "../store";
import { DensityMap } from "./DensityMap";

const state = vi.hoisted(() => ({
  hasResults: true,
  counts: new Map<number, number>(),
  active: null as { page: number; hitIndex: number } | null,
  kind: "phrase" as "phrase" | "proximity",
  outline: { status: "ready", items: [] } as unknown as OutlineState,
  activate: vi.fn(),
}));

vi.mock("./selectors", () => ({
  useHasResults: () => state.hasResults,
  useHitCountsByPage: () => state.counts,
  useActiveHit: () => state.active,
  useResultKind: () => state.kind,
  activateFirstHitFrom: (docId: string, page: number) => state.activate(docId, page),
}));
vi.mock("../outline/outlineStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../outline/outlineStore")>()),
  useOutline: () => state.outline,
}));

const entry = (id: string, title: string, page: number, pageEnd: number, depth = 0, children: OutlineItem[] = []): OutlineItem => ({
  id,
  title,
  page,
  pageEnd,
  depth,
  children,
});

// 40 pages; chapter 3 = pages 14..19 (0-based 13..19) with sub-chapters, like the mockup.
const OUTLINE: OutlineItem[] = [
  entry("0", "1. Objeto", 0, 4),
  entry("1", "2. Obrigações", 5, 12),
  entry("2", "3. Rescisão do contrato", 13, 19, 0, [
    entry("2.0", "3.1 Por iniciativa do cliente", 13, 14, 1),
    entry("2.1", "3.2 Por incumprimento", 15, 17, 1),
    entry("2.2", "3.3 Efeitos da rescisão", 18, 19, 1),
  ]),
  entry("3", "4. Preço", 20, 39),
];

const PAGES_40: PageSize[] = Array.from({ length: 40 }, () => ({ width: 612, height: 792 }));

function setHits(entries: Array<[number, number]>) {
  state.counts = new Map(entries);
}

function mount(props: Partial<React.ComponentProps<typeof DensityMap>> = {}) {
  return render(<DensityMap docId="doc" pages={PAGES_40} zoom={1} scrollEl={null} {...props} />);
}

beforeEach(() => {
  state.hasResults = true;
  state.active = null;
  state.kind = "phrase";
  state.outline = { status: "ready", items: [] };
  state.activate.mockReset();
  setHits([
    [13, 1],
    [14, 1],
    [15, 4],
    [18, 1],
  ]);
});

afterEach(cleanup);

describe("visibility", () => {
  it("shows nothing but an empty gutter without results", () => {
    state.hasResults = false;
    mount();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByTestId("density-bucket")).toBeNull();
    expect(screen.getByTestId("density-gutter")).toHaveClass("w-[30px]"); // the 30px stay reserved
  });

  it("is a 30px strip with one bucket per page that has hits", () => {
    mount();
    expect(screen.getByTestId("density-strip")).toHaveClass("w-[30px]");
    const buckets = screen.getAllByTestId("density-bucket");
    expect(buckets.map((b) => b.getAttribute("data-from-page"))).toEqual(["13", "14", "15", "18"]);
    expect(buckets.map((b) => b.getAttribute("data-count"))).toEqual(["1", "1", "4", "1"]);
    // the busiest bucket is the darkest
    expect(Number(buckets[2].style.opacity)).toBe(1);
    expect(Number(buckets[0].style.opacity)).toBeLessThan(1);
    expect(Number(buckets[0].style.opacity)).toBeGreaterThan(0);
  });
});

describe("chapter ticks and active marker", () => {
  it("draws a tick at every chapter boundary when the PDF has an outline", () => {
    state.outline = { status: "ready", items: OUTLINE };
    mount();
    const ticks = screen.getAllByTestId("density-tick");
    expect(ticks.map((t) => t.style.top)).toEqual(["12.5%", "32.5%", "50%"]); // pages 5, 13, 20 of 40
  });

  it.each([
    ["no outline", { status: "ready", items: [] }],
    ["a loading outline", { status: "loading" }],
    ["a failed outline", { status: "error" }],
  ] as const)("draws no tick with %s", (_name, outline) => {
    state.outline = outline as unknown as OutlineState;
    mount();
    expect(screen.queryByTestId("density-tick")).toBeNull();
  });

  it("puts the amber triangle at the active hit's page and none without an active hit", () => {
    mount();
    expect(screen.queryByTestId("density-active")).toBeNull();
    state.active = { page: 15, hitIndex: 2 };
    cleanup();
    mount();
    const marker = screen.getByTestId("density-active");
    expect(marker.style.top).toBe(`calc(${(15.5 / 40) * 100}% - 5px)`);
    expect(marker).toHaveClass("border-l-[var(--search-active)]");
  });
});

describe("viewport rectangle", () => {
  function scroller(scrollTop: number): HTMLElement {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 800, configurable: true });
    return el;
  }

  it("shows the visible part of the document and follows the scroll", () => {
    const el = scroller(0);
    mount({ scrollEl: el });
    const pageHeight = 792 + VIEWER_PAGE_GAP;
    const rect = screen.getByTestId("density-viewport");
    expect(parseFloat(rect.style.top)).toBeCloseTo(0, 6);
    expect(parseFloat(rect.style.height)).toBeCloseTo(((800 - VIEWER_PADDING) / pageHeight / 40) * 100, 4);

    act(() => {
      el.scrollTop = VIEWER_PADDING + 10 * pageHeight;
      el.dispatchEvent(new Event("scroll"));
    });
    expect(parseFloat(screen.getByTestId("density-viewport").style.top)).toBeCloseTo((10 / 40) * 100, 4);
  });

  it("is not drawn before the scroller is known", () => {
    mount({ scrollEl: null });
    expect(screen.queryByTestId("density-viewport")).toBeNull();
  });
});

describe("accessibility: role=img summary", () => {
  it("describes the hits in words (phrase mode: resultados)", () => {
    mount();
    expect(screen.getByRole("img")).toHaveAccessibleName("Mapa de densidade: 7 resultados nas páginas 14 a 19, a mais densa na página 16");
  });

  it("uses zonas in proximity mode", () => {
    state.kind = "proximity";
    mount();
    expect(screen.getByRole("img")).toHaveAccessibleName("Mapa de densidade: 7 zonas nas páginas 14 a 19, a mais densa na página 16");
  });

  it("singular unit for a single hit", () => {
    setHits([[3, 1]]);
    mount();
    expect(screen.getByRole("img")).toHaveAccessibleName("Mapa de densidade: 1 resultado nas páginas 4 a 4, a mais densa na página 4");
  });
});

describe("tooltip", () => {
  const trackOf = () => screen.getByTestId("density-map").parentElement!;
  // every element is 800px tall at y=0, so a pointer at clientY maps to clientY/800 of the track
  const hoverPage = (page: number) => fireEvent.mouseMove(trackOf(), { clientY: ((page + 0.5) / 40) * 800 });

  it("phrase mode with an outline: pages, resultados and the deepest chapter of the first page", () => {
    state.outline = { status: "ready", items: OUTLINE };
    mount();
    hoverPage(15);
    expect(screen.getByTestId("density-tooltip")).toHaveTextContent("p. 16 · 4 resultados · 3.2 Por incumprimento");
  });

  it("proximity mode says zonas", () => {
    state.kind = "proximity";
    state.outline = { status: "ready", items: OUTLINE };
    mount();
    hoverPage(15);
    expect(screen.getByTestId("density-tooltip")).toHaveTextContent("p. 16 · 4 zonas · 3.2 Por incumprimento");
    hoverPage(13);
    expect(screen.getByTestId("density-tooltip")).toHaveTextContent("p. 14 · 1 zona · 3.1 Por iniciativa do cliente");
  });

  it.each([
    ["phrase", "resultados"],
    ["proximity", "zonas"],
  ] as const)("without an outline there is no chapter (%s)", (kind, unit) => {
    state.kind = kind;
    mount();
    hoverPage(15);
    expect(screen.getByTestId("density-tooltip").textContent).toBe(`p. 16 · 4 ${unit}`);
  });

  it("leaves out the chapter for a page the outline does not cover", () => {
    state.outline = { status: "ready", items: [entry("0", "Capítulo", 20, 39)] };
    mount();
    hoverPage(15);
    expect(screen.getByTestId("density-tooltip").textContent).toBe("p. 16 · 4 resultados");
  });

  it("shows a page range for a bucket that groups several pages", () => {
    // 1000 pages on an 800px track -> 2 pages per bucket
    const pages = Array.from({ length: 1000 }, () => ({ width: 612, height: 792 }));
    setHits([[600, 1], [601, 3]]);
    mount({ pages });
    fireEvent.mouseMove(trackOf(), { clientY: (600.5 / 1000) * 800 });
    expect(screen.getByTestId("density-tooltip").textContent).toBe("p. 601–602 · 4 resultados");
  });

  it("goes away when the pointer leaves or is over empty space", () => {
    mount();
    hoverPage(15);
    expect(screen.getByTestId("density-tooltip")).toBeInTheDocument();
    hoverPage(30);
    expect(screen.queryByTestId("density-tooltip")).toBeNull();
    hoverPage(15);
    fireEvent.mouseLeave(trackOf());
    expect(screen.queryByTestId("density-tooltip")).toBeNull();
  });
});

describe("click", () => {
  it("a bucket activates the first hit from its first page", async () => {
    const user = userEvent.setup();
    mount();
    const jumps = screen.getAllByTestId("density-jump");
    await user.click(jumps[2]);
    expect(state.activate).toHaveBeenCalledTimes(1);
    expect(state.activate).toHaveBeenCalledWith("doc", 15);
  });

  it("a grouped bucket jumps from its first page", async () => {
    const user = userEvent.setup();
    const pages = Array.from({ length: 1000 }, () => ({ width: 612, height: 792 }));
    setHits([[601, 3]]);
    mount({ pages });
    await user.click(screen.getByTestId("density-jump"));
    expect(state.activate).toHaveBeenCalledWith("doc", 600);
  });

  it("empty space jumps from the page under the pointer, like a scrollbar", () => {
    mount();
    const track = screen.getByTestId("density-map").parentElement!;
    fireEvent.click(track, { clientY: (30.5 / 40) * 800 });
    expect(state.activate).toHaveBeenCalledWith("doc", 30);
  });

  it("does not fire twice (button + track)", () => {
    mount();
    fireEvent.click(screen.getAllByTestId("density-jump")[0], { clientY: 0 });
    expect(state.activate).toHaveBeenCalledTimes(1);
    expect(state.activate).toHaveBeenCalledWith("doc", 13);
  });
});

describe("accessibility: keyboard alternative", () => {
  it("is a labelled group of buttons, one per non-empty bucket, outside the image", () => {
    state.outline = { status: "ready", items: OUTLINE };
    mount();
    const group = screen.getByRole("group", { name: "Navegar pelos resultados no mapa de densidade" });
    const img = screen.getByRole("img");
    expect(img.contains(group)).toBe(false);
    const buttons = within(group).getAllByRole("button");
    expect(buttons).toHaveLength(4);
    expect(buttons[2]).toHaveAccessibleName("Ir para p. 16");
    expect(buttons[2]).toHaveAttribute("aria-description", "p. 16 · 4 resultados · 3.2 Por incumprimento");
  });

  it("says which bucket holds the active result without relying on colour", () => {
    state.active = { page: 15, hitIndex: 0 };
    mount();
    const buttons = screen.getAllByRole("button");
    expect(buttons[2]).toHaveAttribute("aria-current", "true");
    expect(buttons[2].getAttribute("aria-label")).toContain("Resultado ativo");
    expect(buttons[0]).not.toHaveAttribute("aria-current");
  });

  it("has one tab stop, moves with the arrow keys, Home and End, and Enter activates", async () => {
    const user = userEvent.setup();
    mount();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((b) => b.tabIndex)).toEqual([0, -1, -1, -1]);

    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(buttons[1]).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(buttons[3]).toHaveFocus();
    await user.keyboard("{ArrowDown}"); // stops at the end
    expect(buttons[3]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(buttons[2]).toHaveFocus();
    expect(buttons.map((b) => b.tabIndex)).toEqual([-1, -1, 0, -1]);
    await user.keyboard("{Home}");
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{End}");
    expect(buttons[3]).toHaveFocus();

    await user.keyboard("{Enter}");
    expect(state.activate).toHaveBeenCalledTimes(1);
    expect(state.activate).toHaveBeenCalledWith("doc", 18);
  });

  it("shows the tooltip for the focused bucket", async () => {
    const user = userEvent.setup();
    mount();
    await user.tab();
    expect(screen.getByTestId("density-tooltip")).toHaveTextContent("p. 14 · 1 resultado");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByTestId("density-tooltip")).toHaveTextContent("p. 16 · 4 resultados");
  });

  it("starts the tab stop on the active result's bucket", () => {
    state.active = { page: 18, hitIndex: 0 };
    mount();
    expect(screen.getAllByRole("button").map((b) => b.tabIndex)).toEqual([-1, -1, -1, 0]);
  });
});
