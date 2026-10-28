// Mock implementation of the "text" domain (CONTRACTS §3/§5).
//
// `text_page_layout` / `text_extract_range` operate on `mock/state.ts`'s
// fake per-page `pageText` strings via a trivial monospaced grid layout
// (not pixel-accurate — there's no real font shaping here, just enough
// geometry for a demo to draw selection/search boxes against).
//
// This per-page body text is intentionally independent fake data from
// textedit.ts's text-run objects (`fontName`/`fontSize`/etc.) — keeping the
// two in sync would model a level of engine detail (text objects that
// literally compose the extractable page text) out of scope for a wave-0
// mock. Documented limitation, not an oversight.
//
// Search (CONTRACTS v1.2.0) is a faithful-enough model of the real engine for building the UI:
// phrase and proximity modes, `"…"` phrase terms and `-term` exclusions, scopes (all / pages /
// outline entry), case, whole word, accent-insensitive matching (plus ligatures, curly quotes,
// NBSP and soft hyphens), hits that continue onto the next page, compactness scores and
// header/footer furniture. Mock-only simplifications: the grid layout has no real line breaks,
// so hard hyphens at line ends are not modelled, and only the "book" fake document has
// headers/footers (its first grid line and its "Página N de M" line).
import type {
  CharBox,
  ContextTerm,
  HitRect,
  OutlineItem,
  PageFurniture,
  PageRect,
  Rect,
  SearchHit,
  SearchMatch,
  SearchQuery,
  TextRange,
} from "../bindings";
import { searchBatch } from "./events";
import { type CommandResult, type MockDoc, MOCK_CHARS_PER_LINE, err, findDocById, ok } from "./state";

const MARGIN = 72;
const CHAR_WIDTH = 7;
const LINE_HEIGHT = 14;
const CHARS_PER_LINE = MOCK_CHARS_PER_LINE;

function charRect(pageHeight: number, charIndex: number, spanChars = 1): Rect {
  const col = charIndex % CHARS_PER_LINE;
  const row = Math.floor(charIndex / CHARS_PER_LINE);
  return {
    x: MARGIN + col * CHAR_WIDTH,
    y: pageHeight - MARGIN - row * LINE_HEIGHT,
    width: CHAR_WIDTH * spanChars,
    height: LINE_HEIGHT,
  };
}

export async function textPageLayout(docId: string, page: number): Promise<CommandResult<CharBox[]>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const text = doc.mutable.pageText[page];
  const pageSize = doc.mutable.pages[page];
  if (text === undefined || !pageSize) return err("INVALID_ARG", `page ${page} out of range`);
  const boxes: CharBox[] = [];
  for (let i = 0; i < text.length; i++) {
    boxes.push({ charIndex: i, rect: charRect(pageSize.height, i) });
  }
  return ok(boxes);
}

export async function textExtractRange(docId: string, range: TextRange): Promise<CommandResult<string>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  const text = doc.mutable.pageText[range.page];
  if (text === undefined) return err("INVALID_ARG", `page ${range.page} out of range`);
  if (range.start < 0 || range.end < range.start) return err("INVALID_ARG", "invalid text range");
  return ok(text.slice(range.start, Math.min(range.end, text.length)));
}

// --- search ------------------------------------------------------------------------------------

interface SearchSession {
  cancelled: boolean;
}

const sessions = new Map<string, SearchSession>();

const CONTEXT_CHARS = 60;
const MATCHED_MAX = 160;
const MATCHED_KEEP = 70;
export const PROXIMITY_WINDOW_MIN = 20;
export const PROXIMITY_WINDOW_MAX = 5000;

/** One rect per grid line the range touches, so a range that wraps is still one hit. */
function lineRects(pageHeight: number, start: number, length: number): Rect[] {
  const rects: Rect[] = [];
  let index = start;
  const end = start + Math.max(length, 1);
  while (index < end) {
    const lineEnd = (Math.floor(index / CHARS_PER_LINE) + 1) * CHARS_PER_LINE;
    const span = Math.min(end, lineEnd) - index;
    rects.push(charRect(pageHeight, index, span));
    index += span;
  }
  return rects;
}

/** Collapses whitespace runs to one space, keeping a map from each output char to its input offset. */
function collapseWithMap(value: string): { text: string; map: number[] } {
  let text = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (/\s/.test(c)) {
      if (!lastSpace) {
        text += " ";
        map.push(i);
      }
      lastSpace = true;
    } else {
      text += c;
      map.push(i);
      lastSpace = false;
    }
  }
  return { text, map };
}

function collapse(value: string): string {
  return collapseWithMap(value).text;
}

/** Search-time folding of ONE original char (may yield 0–2 chars). */
function foldChar(c: string, caseSensitive: boolean, ignoreDiacritics: boolean): string {
  if (c === "­") return ""; // soft hyphen: always removed
  if (c === " ") return " ";
  if (c === "ﬁ") c = "fi";
  else if (c === "ﬂ") c = "fl";
  else if (c === "“" || c === "”") c = '"';
  else if (c === "‘" || c === "’") c = "'";
  if (ignoreDiacritics) c = c.normalize("NFD").replace(/\p{M}/gu, "");
  return caseSensitive ? c : c.toLowerCase();
}

function foldText(value: string, caseSensitive: boolean, ignoreDiacritics: boolean): string {
  let out = "";
  for (const c of value) out += foldChar(c, caseSensitive, ignoreDiacritics);
  return collapse(out).trim();
}

/** Where a stream char came from: page + original char index (`-1` for a page separator). */
interface StreamPos {
  page: number;
  index: number;
}

/** The scope's text, folded and whitespace-collapsed, with every char mapped back to its origin. */
interface Stream {
  text: string;
  at: StreamPos[];
}

function buildStream(doc: MockDoc, pages: number[], query: SearchQuery, furniture: Map<number, [number, number][]>): Stream {
  let text = "";
  const at: StreamPos[] = [];
  const pushSpace = (pos: StreamPos) => {
    if (text.length > 0 && !text.endsWith(" ")) {
      text += " ";
      at.push(pos);
    }
  };
  for (const page of pages) {
    const source = doc.mutable.pageText[page] ?? "";
    const excluded = furniture.get(page) ?? [];
    pushSpace({ page, index: -1 });
    for (let i = 0; i < source.length; i++) {
      if (excluded.some(([s, e]) => i >= s && i < e)) continue;
      for (const c of foldChar(source[i], query.caseSensitive, query.ignoreDiacritics)) {
        if (/\s/.test(c)) pushSpace({ page, index: i });
        else {
          text += c;
          at.push({ page, index: i });
        }
      }
    }
  }
  return { text, at };
}

/** Mock header/footer detection: only the "book" document has them (first grid line + "Página N de M"). */
function mockFurniture(doc: MockDoc, page: number): [number, number][] {
  if (doc.kind !== "book" || page === 0) return [];
  const text = doc.mutable.pageText[page] ?? "";
  const footer = text.lastIndexOf("Página ");
  const ranges: [number, number][] = [[0, CHARS_PER_LINE]];
  if (footer >= 0) ranges.push([footer, text.length]);
  return ranges;
}

/** Same rule as the engine's `deepest_item_for_page`: a page-less entry never matches, its children still can. */
function deepestItem(outline: OutlineItem[], page: number): OutlineItem | null {
  for (const item of outline) {
    if (item.page !== null && item.pageEnd !== null) {
      if (page >= item.page && page <= item.pageEnd) return deepestItem(item.children, page) ?? item;
    } else {
      const inside = deepestItem(item.children, page);
      if (inside) return inside;
    }
  }
  return null;
}

function findItem(outline: OutlineItem[], id: string): OutlineItem | null {
  for (const item of outline) {
    if (item.id === id) return item;
    const found = findItem(item.children, id);
    if (found) return found;
  }
  return null;
}

function resolveScope(doc: MockDoc, query: SearchQuery): number[] | string {
  const count = doc.mutable.pageText.length;
  const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  switch (query.scope.kind) {
    case "all":
      return range(0, count - 1);
    case "pages": {
      const { from, to } = query.scope;
      if (from < 0 || to < from || to >= count) return `invalid page range ${from}–${to}`;
      return range(from, to);
    }
    case "outline": {
      const item = findItem(doc.outline, query.scope.itemId);
      if (!item || item.page === null || item.pageEnd === null) return `unknown outline item "${query.scope.itemId}"`;
      return range(item.page, item.pageEnd);
    }
  }
}

/** Proximity syntax: `"…"` is one phrase term, `-term` excludes, anything else is a term. */
export function parseProximityTerms(text: string): { positive: string[]; excluded: string[] } {
  const positive: string[] = [];
  const excluded: string[] = [];
  for (const match of text.matchAll(/(-?)"([^"]*)"|(\S+)/g)) {
    const quoted = match[2];
    const bare = match[3];
    if (quoted !== undefined) {
      if (quoted.trim()) (match[1] ? excluded : positive).push(quoted.trim());
    } else if (bare.startsWith("-") && bare.length > 1) excluded.push(bare.slice(1));
    else if (bare !== "-") positive.push(bare);
  }
  return { positive, excluded };
}

interface Occurrence {
  start: number;
  end: number;
  term: number;
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

function occurrences(stream: Stream, needle: string, term: number, wholeWord: boolean): Occurrence[] {
  const found: Occurrence[] = [];
  if (!needle) return found;
  let from = 0;
  for (;;) {
    const start = stream.text.indexOf(needle, from);
    if (start === -1) break;
    const end = start + needle.length;
    const boundary = !WORD_CHAR.test(stream.text[start - 1] ?? " ") && !WORD_CHAR.test(stream.text[end] ?? " ");
    if (!wholeWord || boundary) found.push({ start, end, term });
    from = start + 1;
  }
  return found;
}

/** Original `[start, end)` char ranges, per page, covered by stream span `[s, e)`. */
function originalRanges(stream: Stream, s: number, e: number): { page: number; start: number; end: number }[] {
  const ranges: { page: number; start: number; end: number }[] = [];
  for (let i = s; i < e; i++) {
    const pos = stream.at[i];
    if (pos.index < 0) continue;
    const last = ranges[ranges.length - 1];
    if (last && last.page === pos.page) {
      last.start = Math.min(last.start, pos.index);
      last.end = Math.max(last.end, pos.index + 1);
    } else ranges.push({ page: pos.page, start: pos.index, end: pos.index + 1 });
  }
  return ranges;
}

function buildHit(doc: MockDoc, stream: Stream, s: number, e: number, terms: Occurrence[], proximity: boolean): SearchHit {
  const height = (page: number) => doc.mutable.pages[page]?.height ?? 792;
  const pieces = originalRanges(stream, s, e);
  const first = pieces[0];
  const last = pieces[pieces.length - 1];

  const rects: HitRect[] = [];
  for (const occ of terms) {
    for (const r of originalRanges(stream, occ.start, occ.end)) {
      for (const rect of lineRects(height(r.page), r.start, r.end - r.start)) rects.push({ page: r.page, rect, term: occ.term });
    }
  }
  const windowRects: PageRect[] = proximity
    ? pieces.flatMap((r) => lineRects(height(r.page), r.start, r.end - r.start).map((rect) => ({ page: r.page, rect })))
    : [];

  // Context: original text, whitespace collapsed; term offsets tracked through the collapse.
  const raw = pieces.map((r) => doc.mutable.pageText[r.page].slice(r.start, r.end)).join(" ");
  const pieceOffset = (page: number, index: number): number => {
    let offset = 0;
    for (const r of pieces) {
      if (r.page === page) return offset + (index - r.start);
      offset += r.end - r.start + 1;
    }
    return 0;
  };
  const { text: collapsed, map } = collapseWithMap(raw);
  const toCollapsed = (rawOffset: number) => {
    const i = map.findIndex((m) => m >= rawOffset);
    return i === -1 ? collapsed.length : i;
  };
  let contextTerms: ContextTerm[] = terms.map((occ) => {
    const range = originalRanges(stream, occ.start, occ.end)[0];
    const start = toCollapsed(pieceOffset(range.page, range.start));
    const end = toCollapsed(pieceOffset(range.page, range.start) + (occ.end - occ.start));
    return { start, len: Math.max(1, end - start), term: occ.term };
  });
  let matched = collapsed;
  if (matched.length > MATCHED_MAX) {
    const cut = matched.length - 2 * MATCHED_KEEP;
    const gap = " … ";
    contextTerms = contextTerms
      .filter((t) => t.start + t.len <= MATCHED_KEEP || t.start >= matched.length - MATCHED_KEEP)
      .map((t) => (t.start >= MATCHED_KEEP ? { ...t, start: t.start - cut + gap.length } : t));
    matched = matched.slice(0, MATCHED_KEEP) + gap + matched.slice(matched.length - MATCHED_KEEP);
  }
  const startText = doc.mutable.pageText[first.page];
  const endText = doc.mutable.pageText[last.page];

  return {
    rects,
    charStart: first.start,
    charLen: first.end - first.start,
    context: {
      before: collapse(startText.slice(Math.max(0, first.start - CONTEXT_CHARS), first.start)).trimStart(),
      matched,
      after: collapse(endText.slice(last.end, last.end + CONTEXT_CHARS)).trimEnd(),
      terms: contextTerms,
    },
    windowRects,
    score: proximity ? e - s : null,
    spansPages: first.page !== last.page ? [first.page, last.page] : null,
    outlineItemId: deepestItem(doc.outline, first.page)?.id ?? null,
  };
}

function phraseHits(doc: MockDoc, stream: Stream, query: SearchQuery): SearchHit[] {
  const needle = foldText(query.text, query.caseSensitive, query.ignoreDiacritics);
  return occurrences(stream, needle, 0, query.wholeWord)
    .filter((occ) => {
      const pages = new Set(originalRanges(stream, occ.start, occ.end).map((r) => r.page));
      return pages.size <= 2;
    })
    .map((occ) => buildHit(doc, stream, occ.start, occ.end, [occ], false));
}

function proximityHits(doc: MockDoc, stream: Stream, query: SearchQuery, window: number): SearchHit[] {
  const { positive, excluded } = parseProximityTerms(query.text);
  const fold = (t: string) => foldText(t, query.caseSensitive, query.ignoreDiacritics);
  const all = positive
    .flatMap((term, index) => occurrences(stream, fold(term), index, query.wholeWord))
    .sort((a, b) => a.start - b.start || a.term - b.term);
  const excludedOccs = excluded.flatMap((term) => occurrences(stream, fold(term), -1, query.wholeWord));

  // Smallest window starting at each occurrence: for every term, its first occurrence at/after the start.
  const candidates: { s: number; e: number }[] = [];
  for (const startOcc of all) {
    let end = startOcc.end;
    let complete = true;
    for (let term = 0; term < positive.length; term++) {
      const next = all.find((o) => o.term === term && o.start >= startOcc.start);
      if (!next) {
        complete = false;
        break;
      }
      end = Math.max(end, next.end);
    }
    if (complete) candidates.push({ s: startOcc.start, e: end });
  }
  // Keep minimal windows (none nested inside a later one), then drop overlaps in document order.
  const minimal = candidates.filter((c, i) => !candidates.slice(i + 1).some((d) => d.e <= c.e));
  const hits: SearchHit[] = [];
  let lastEnd = -1;
  for (const { s, e } of minimal) {
    if (s < lastEnd || e - s > window) continue;
    if (excludedOccs.some((x) => x.start < e && x.end > s)) continue;
    const pages = new Set(originalRanges(stream, s, e).map((r) => r.page));
    if (pages.size > 2) continue;
    const inside = all.filter((o) => o.start >= s && o.end <= e);
    hits.push(buildHit(doc, stream, s, e, inside, true));
    lastEnd = e;
  }
  return hits;
}

/** INVALID_ARG reasons the real engine also enforces (CONTRACTS v1.2.0). */
function validate(query: SearchQuery): string | null {
  if (!query.text.trim()) return "empty search query";
  if (query.mode === "proximity") {
    if (parseProximityTerms(query.text).positive.length === 0) return "a proximity query needs at least one term";
    const window = query.proximity?.window;
    if (window === undefined || window < PROXIMITY_WINDOW_MIN || window > PROXIMITY_WINDOW_MAX) {
      return `proximity window must be ${PROXIMITY_WINDOW_MIN}–${PROXIMITY_WINDOW_MAX} characters`;
    }
  }
  return null;
}

export async function textSearchStart(docId: string, searchId: string, query: SearchQuery): Promise<CommandResult<null>> {
  const doc = findDocById(docId);
  if (!doc) return err("NOT_FOUND", `no open document with id "${docId}"`);
  if (sessions.has(searchId)) return err("INVALID_ARG", `search "${searchId}" is already running`);
  const invalid = validate(query);
  if (invalid) return err("INVALID_ARG", invalid);
  const pages = resolveScope(doc, query);
  if (typeof pages === "string") return err("INVALID_ARG", pages);

  const session: SearchSession = { cancelled: false };
  sessions.set(searchId, session);
  // Fire-and-forget: the command resolves immediately, results stream via `search_batch` events
  // for the client-minted searchId (CONTRACTS §3).
  void runSearch(searchId, doc, pages, query, session);
  return ok(null);
}

async function runSearch(searchId: string, doc: MockDoc, pages: number[], query: SearchQuery, session: SearchSession): Promise<void> {
  const pageCount = pages.length;
  const textless = pages.every((page) => (doc.mutable.pageText[page] ?? "").trim() === "");
  const furniture = new Map<number, [number, number][]>();
  if (query.excludeHeadersFooters) for (const page of pages) furniture.set(page, mockFurniture(doc, page));

  const stream = buildStream(doc, pages, query, furniture);
  const proximity = query.mode === "proximity";
  const hits = proximity ? proximityHits(doc, stream, query, query.proximity?.window ?? 500) : phraseHits(doc, stream, query);
  const byPage = new Map<number, SearchHit[]>();
  for (const hit of hits) {
    const page = hit.rects[0]?.page ?? hit.windowRects[0]?.page ?? 0;
    byPage.set(page, [...(byPage.get(page) ?? []), hit]);
  }

  for (let i = 0; i < pages.length; i++) {
    // A small per-page delay so results genuinely stream — this is what makes
    // `text_search_cancel` meaningful to call mid-search.
    await new Promise<void>((resolve) => setTimeout(resolve, 30));
    if (session.cancelled) return;
    const page = pages[i];
    const pageHits = byPage.get(page);
    const matches: SearchMatch[] = pageHits ? [{ page, hits: pageHits }] : [];
    const pageFurniture: PageFurniture[] = (furniture.get(page) ?? []).length
      ? [
          {
            page,
            rects: (furniture.get(page) ?? []).flatMap(([s, e]) => lineRects(doc.mutable.pages[page]?.height ?? 792, s, e - s)),
          },
        ]
      : [];
    void searchBatch.emit({
      searchId,
      matches,
      done: false,
      pagesSearched: i + 1,
      pageCount,
      textless: false,
      ranked: false,
      furniture: pageFurniture,
    });
  }
  if (!session.cancelled) {
    void searchBatch.emit({
      searchId,
      matches: [],
      done: true,
      pagesSearched: pageCount,
      pageCount,
      textless,
      ranked: proximity,
      furniture: [],
    });
  }
  sessions.delete(searchId);
}

export async function textSearchCancel(searchId: string): Promise<CommandResult<null>> {
  const session = sessions.get(searchId);
  if (session) session.cancelled = true;
  sessions.delete(searchId);
  return ok(null);
}
