import { describe, expect, it } from "vitest";
import type { FormField } from "../../ipc/bindings";
import { sortFieldsInDocumentOrder } from "./sortFieldsInDocumentOrder";

function field(id: string, page: number, x: number, y: number): FormField {
  return {
    id,
    page,
    rect: { x, y, width: 100, height: 20 },
    kind: "text",
    value: "",
    options: null,
    readOnly: false,
    required: false,
  };
}

describe("sortFieldsInDocumentOrder", () => {
  it("orders fields by ascending page first", () => {
    const fields = [field("page1-a", 1, 0, 0), field("page0-a", 0, 0, 0)];
    const ordered = sortFieldsInDocumentOrder(fields);
    expect(ordered.map((f) => f.id)).toEqual(["page0-a", "page1-a"]);
  });

  it("within a page, orders top-to-bottom by descending PDF y (higher y is higher on the page)", () => {
    const fields = [field("low", 0, 0, 100), field("high", 0, 0, 700), field("mid", 0, 0, 400)];
    const ordered = sortFieldsInDocumentOrder(fields);
    expect(ordered.map((f) => f.id)).toEqual(["high", "mid", "low"]);
  });

  it("on the same row (equal y), orders left-to-right by ascending x", () => {
    const fields = [field("right", 0, 300, 500), field("left", 0, 50, 500), field("middle", 0, 150, 500)];
    const ordered = sortFieldsInDocumentOrder(fields);
    expect(ordered.map((f) => f.id)).toEqual(["left", "middle", "right"]);
  });

  it("falls back to id as a final deterministic tiebreak for identical page/x/y", () => {
    const fields = [field("zeta", 0, 10, 10), field("alpha", 0, 10, 10)];
    const ordered = sortFieldsInDocumentOrder(fields);
    expect(ordered.map((f) => f.id)).toEqual(["alpha", "zeta"]);
  });

  it("combines all rules across a realistic two-page, out-of-order document", () => {
    const fields = [
      field("p1-bottom-left", 1, 50, 100),
      field("p0-bottom", 0, 72, 100),
      field("p1-top", 1, 72, 700),
      field("p0-top-right", 0, 300, 700),
      field("p0-top-left", 0, 72, 700),
    ];
    const ordered = sortFieldsInDocumentOrder(fields);
    expect(ordered.map((f) => f.id)).toEqual(["p0-top-left", "p0-top-right", "p0-bottom", "p1-top", "p1-bottom-left"]);
  });

  it("is pure — does not mutate its input and returns a new array", () => {
    const fields = [field("b", 0, 0, 0), field("a", 0, 0, 10)];
    const original = [...fields];
    const ordered = sortFieldsInDocumentOrder(fields);
    expect(fields).toEqual(original);
    expect(ordered).not.toBe(fields);
  });
});
