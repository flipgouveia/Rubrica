import { describe, expect, it } from "vitest";
import { parseQueryTerms, positiveTerms } from "./queryTerms";

describe("proximity query syntax", () => {
  it("splits on spaces and numbers the positive terms by position", () => {
    expect(parseQueryTerms("rescisão prazo indemnização")).toEqual([
      { text: "rescisão", excluded: false, index: 0 },
      { text: "prazo", excluded: false, index: 1 },
      { text: "indemnização", excluded: false, index: 2 },
    ]);
  });

  it("keeps a quoted phrase as one term and understands -term / -\"phrase\" exclusions", () => {
    const terms = parseQueryTerms('rescisão "justa causa" -anexo prazo -"nota final"');
    expect(terms.map((t) => [t.text, t.excluded, t.index])).toEqual([
      ["rescisão", false, 0],
      ["justa causa", false, 1],
      ["anexo", true, -1],
      ["prazo", false, 2], // an exclusion does not take a colour position
      ["nota final", true, -1],
    ]);
  });

  it("ignores a lone dash and empty quotes", () => {
    expect(parseQueryTerms('- "" a')).toEqual([{ text: "a", excluded: false, index: 0 }]);
    expect(positiveTerms("-a -b")).toEqual([]);
  });
});
