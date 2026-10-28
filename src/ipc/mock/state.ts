// Shared in-memory state for the mock engine (CONTRACTS §5).
//
// Two fake documents live here for the lifetime of the module (i.e. until
// the page reloads): a 5-page plain-text document and a 2-page form
// document. Every mock command module (document.ts, annotations.ts,
// pages.ts, forms.ts, textedit.ts, redact.ts, text.ts, history.ts) reads
// and mutates this state through the helpers exported below rather than
// touching the registry directly, so revision/undo/dirty bookkeeping and
// `doc_state_changed` emission stay centralized and consistent.
//
// Documented mock-only behaviors (none of this is part of CONTRACTS, all of
// it is a deliberate, simple choice for a wave-0 fake backend):
//
// - `docId` is a stable constant per fake document ("mock-text-doc" /
//   "mock-form-doc"), not minted per `doc_open` call — there is exactly one
//   living instance of each fake document, matching CONTRACTS §5's "two
//   in-memory fake documents power the whole surface".
// - Closing a document with unsaved changes (`dirty`) reverts it to the
//   last-saved `baseline` snapshot (or the pristine initial fixture, if
//   never saved) — mirroring "close without saving discards edits" in a
//   real editor. Closing a clean document is a no-op beyond flipping
//   `isOpen`. Reopening always resumes whatever the current baseline is.
// - `revision` is a monotonically increasing counter, per document, that
//   never resets — every mutation, undo, redo, and discard-on-close bumps
//   it, since its only job is cache-busting the `(page, zoomBucket,
//   revision)`-keyed tile cache; it deliberately does NOT reflect a
//   "logical version number".
// - `dirty` is derived as `undoStack.length !== savedAtDepth`: this makes
//   undo-ing all the way back past the last save point honestly report
//   `dirty: false` again, same as most real editors.
// - Undo/redo is implemented via whole-document snapshots
//   (`structuredClone`) rather than per-field revert logic. These are tiny
//   fake documents, so this is simpler and more robust than hand-rolled
//   inverse operations, at the cost of being O(document size) per step —
//   irrelevant at this scale.
// - `pages_reorder` / `pages_delete` / `pages_insert_*` remap the `page`
//   field of annotations, form fields, and text-run objects (and the fake
//   per-page body text) so associated data follows its page across a
//   structural change. Real PDFium-backed pages would need the same
//   remapping engine-side.
import type { Annot, DocInfo, FormField, MutationResult, OutlineItem, PageSize, Rect, RubricaError, RubricaErrorCode, TextRun } from "../bindings";
import { docStateChanged, saveState } from "./events";

export type DocKind = "text" | "form" | "perf" | "book";

export type CommandResult<T> = { status: "ok"; data: T } | { status: "error"; error: RubricaError };

export function ok<T>(data: T): CommandResult<T> {
  return { status: "ok", data };
}

export function err(code: RubricaErrorCode, message: string): CommandResult<never> {
  return { status: "error", error: { code, message } };
}

export interface MockPageState {
  width: number;
  height: number;
  /** Degrees, normalized to [0, 360). Only affects `DocInfo.pages`' reported width/height (swapped at 90/270). */
  rotation: number;
}

/** `TextRun` plus the page it lives on — the real `TextRun` shape has no `page` field (see textedit.ts). */
export interface MockTextRunState extends TextRun {
  page: number;
}

export interface RedactedRegion {
  page: number;
  rects: Rect[];
}

/** Everything that undo/redo snapshots and that structural page edits remap. */
export interface MutableDocState {
  pages: MockPageState[];
  /** Fake per-page body text backing text_page_layout / text_extract_range / search. */
  pageText: string[];
  annotations: Annot[];
  formFields: FormField[];
  textRuns: MockTextRunState[];
  redactedRects: RedactedRegion[];
}

interface UndoEntry {
  before: MutableDocState;
  after: MutableDocState;
  invalidatedPages: number[];
}

export interface MockDoc {
  docId: string;
  kind: DocKind;
  path: string;
  encrypted: boolean;
  hasForm: boolean;
  isOpen: boolean;
  revision: number;
  /** `undoStack.length` at the moment of the last `doc_save` (0 if never saved). */
  savedAtDepth: number;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Last-saved (or pristine initial) content — what "closing without saving" reverts to. */
  baseline: MutableDocState;
  mutable: MutableDocState;
  /**
   * `doc_outline` (CONTRACTS v1.2.0). Static: page edits don't remap it (mock limitation — the
   * real engine re-reads the bookmarks every time).
   */
  outline: OutlineItem[];
}

function cloneMutable(state: MutableDocState): MutableDocState {
  return structuredClone(state);
}

const idCounters: Record<string, number> = {};

export function generateId(prefix: string): string {
  idCounters[prefix] = (idCounters[prefix] ?? 0) + 1;
  return `${prefix}-${idCounters[prefix]}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TEXT_DOC_ID = "mock-text-doc";
const FORM_DOC_ID = "mock-form-doc";
const PERF_DOC_ID = "mock-perf-doc";
const PERF_PAGE_COUNT = 500;

function buildTextPageBody(pageIndex: number): string {
  return (
    `Rubrica mock document, page ${pageIndex + 1} of 5. This paragraph exists only so the ` +
    `wave-0 mock engine has something to lay out, search, and extract. Search for the word ` +
    `Rubrica to see live results stream across every page of this fake document.`
  );
}

function createTextDocState(): MockDoc {
  const pages: MockPageState[] = Array.from({ length: 5 }, () => ({ width: 612, height: 792, rotation: 0 }));
  const pageText = pages.map((_, i) => buildTextPageBody(i));
  const textRuns: MockTextRunState[] = pages.map((_, i) => ({
    page: i,
    objectId: `to-${TEXT_DOC_ID}-${i}`,
    rect: { x: 72, y: 700, width: 300, height: 20 },
    text: `Page ${i + 1} heading`,
    fontName: "Helvetica",
    fontSize: 14,
    embeddedFontUsable: true,
  }));
  const mutable: MutableDocState = { pages, pageText, annotations: [], formFields: [], textRuns, redactedRects: [] };
  return {
    docId: TEXT_DOC_ID,
    kind: "text",
    path: "",
    encrypted: false,
    hasForm: false,
    isOpen: false,
    revision: 0,
    savedAtDepth: 0,
    undoStack: [],
    redoStack: [],
    baseline: cloneMutable(mutable),
    outline: [],
    mutable,
  };
}

function createFormDocState(): MockDoc {
  const pages: MockPageState[] = [
    { width: 612, height: 792, rotation: 0 },
    { width: 612, height: 792, rotation: 0 },
  ];
  const pageText = [
    "Rubrica mock form, page 1. Fill in the fields below to try form filling in the mock engine.",
    "Rubrica mock form, page 2. Additional fields continue here.",
  ];
  const formFields: FormField[] = [
    {
      id: "field-name",
      page: 0,
      rect: { x: 100, y: 650, width: 300, height: 24 },
      kind: "text",
      value: "",
      options: null,
      readOnly: false,
      required: true,
    },
    {
      id: "field-subscribe",
      page: 0,
      rect: { x: 100, y: 600, width: 20, height: 20 },
      kind: "checkbox",
      value: "Off",
      options: null,
      readOnly: false,
      required: false,
    },
    {
      id: "field-plan",
      page: 0,
      rect: { x: 100, y: 500, width: 200, height: 80 },
      kind: "radio",
      value: "",
      options: ["Basic", "Pro", "Enterprise"],
      readOnly: false,
      required: true,
    },
    {
      id: "field-country",
      page: 1,
      rect: { x: 100, y: 650, width: 200, height: 24 },
      kind: "combo",
      value: "Portugal",
      options: ["Portugal", "Spain", "France"],
      readOnly: false,
      required: false,
    },
    {
      id: "field-language",
      page: 1,
      rect: { x: 100, y: 550, width: 200, height: 60 },
      kind: "listbox",
      value: "pt-PT",
      options: ["pt-PT", "en", "es", "fr"],
      readOnly: false,
      required: false,
    },
  ];
  const textRuns: MockTextRunState[] = pages.map((_, i) => ({
    page: i,
    objectId: `to-${FORM_DOC_ID}-${i}`,
    rect: { x: 72, y: 740, width: 300, height: 20 },
    text: i === 0 ? "Mock Application Form" : "Mock Application Form (cont.)",
    fontName: "Times-Roman",
    fontSize: 16,
    embeddedFontUsable: i === 0,
  }));
  const mutable: MutableDocState = { pages, pageText, annotations: [], formFields, textRuns, redactedRects: [] };
  return {
    docId: FORM_DOC_ID,
    kind: "form",
    path: "",
    encrypted: false,
    hasForm: true,
    isOpen: false,
    revision: 0,
    savedAtDepth: 0,
    undoStack: [],
    redoStack: [],
    baseline: cloneMutable(mutable),
    outline: [],
    mutable,
  };
}

/**
 * R3 brief item 6 ("a fake 500-page doc for perf work"): a third fake document, all pages the
 * same tiny letter-size sheet, so the viewer's virtualization/zoom/tile-prefetch code has
 * something real to be exercised against beyond the 5-page text doc. Deliberately uninteresting
 * per-page content (unlike the text doc's "search for the word Rubrica" hook) — this document
 * exists for scroll/zoom/render performance, not for exercising search or editing.
 */
function createPerfDocState(): MockDoc {
  const pages: MockPageState[] = Array.from({ length: PERF_PAGE_COUNT }, () => ({ width: 612, height: 792, rotation: 0 }));
  const pageText = pages.map(
    (_, i) => `Rubrica performance fixture, page ${i + 1} of ${PERF_PAGE_COUNT}. Uniform filler content for scroll and zoom testing.`,
  );
  const textRuns: MockTextRunState[] = pages.map((_, i) => ({
    page: i,
    objectId: `to-${PERF_DOC_ID}-${i}`,
    rect: { x: 72, y: 740, width: 300, height: 20 },
    text: `Page ${i + 1}`,
    fontName: "Helvetica",
    fontSize: 12,
    embeddedFontUsable: true,
  }));
  const mutable: MutableDocState = { pages, pageText, annotations: [], formFields: [], textRuns, redactedRects: [] };
  return {
    docId: PERF_DOC_ID,
    kind: "perf",
    path: "",
    encrypted: false,
    hasForm: false,
    isOpen: false,
    revision: 0,
    savedAtDepth: 0,
    undoStack: [],
    redoStack: [],
    baseline: cloneMutable(mutable),
    outline: [],
    mutable,
  };
}

const BOOK_DOC_ID = "mock-book-doc";
const BOOK_PAGE_COUNT = 12;
/** Grid columns of `mock/text.ts`'s layout; the header is padded to one full line. */
const BOOK_LINE = 60;

/**
 * Search v2 fixture for the UI (CONTRACTS v1.2.0): a 12-page pt-PT "manual" with a real outline,
 * running headers (even pages: the book title; odd pages: the chapter), a "Página N de 12"
 * footer, accented words, a tight proximity zone ("rescisão" · "prazo" · "indemnização" on
 * p. 6), a loose one spread over p. 10–11 (window > 250, < 500 chars) and a phrase split by the
 * p. 8/9 page break ("fazer cessar | o acordo"). 1-based page numbers in this comment.
 */
const BOOK_OUTLINE: OutlineItem[] = [
  {
    id: "0",
    title: "1 Introdução",
    page: 1,
    pageEnd: 3,
    depth: 0,
    children: [
      { id: "0.0", title: "1.1 Âmbito", page: 1, pageEnd: 2, depth: 1, children: [] },
      { id: "0.1", title: "1.2 Definições", page: 3, pageEnd: 3, depth: 1, children: [] },
    ],
  },
  {
    id: "1",
    title: "2 Cessação do contrato",
    page: 4,
    pageEnd: 8,
    depth: 0,
    children: [
      { id: "1.0", title: "2.1 Por acordo", page: 4, pageEnd: 4, depth: 1, children: [] },
      {
        id: "1.1",
        title: "2.2 Por incumprimento",
        page: 5,
        pageEnd: 7,
        depth: 1,
        children: [{ id: "1.1.0", title: "2.2.1 Incumprimento definitivo", page: 7, pageEnd: 7, depth: 2, children: [] }],
      },
      { id: "1.2", title: "2.3 Efeitos", page: 8, pageEnd: 8, depth: 1, children: [] },
    ],
  },
  { id: "2", title: "3 Disposições finais", page: 9, pageEnd: 11, depth: 0, children: [] },
];

const BOOK_FILLER = [
  "O presente contrato regula a prestação de serviços entre as partes identificadas.",
  "A ação de cada parte deve respeitar a boa-fé e as obrigações assumidas no contrato.",
  "As notificações são feitas por escrito para o endereço indicado na cláusula própria.",
  "Qualquer alteração ao contrato só produz efeitos depois de assinada por ambas as partes.",
  "O código civil aplica-se a tudo o que não estiver previsto neste documento.",
];

/** Body text of each 0-based page; the controlled zones are spelled out explicitly. */
const BOOK_BODY: Record<number, string> = {
  0: "Manual de Contratos. Ficheiro de teste do motor de pesquisa (mock).",
  5:
    "Em caso de incumprimento grave, a rescisão com justa causa obriga a conceder um prazo " +
    "de trinta dias, findo o qual a parte lesada tem direito a uma indemnização. " +
    BOOK_FILLER[0],
  8: BOOK_FILLER[1] + " A parte que pretenda fazer cessar",
  9: "o acordo deve comunicá-lo por escrito. " + BOOK_FILLER[3],
  10:
    BOOK_FILLER[2] + " Admite-se a rescisão unilateral nos casos previstos. " + BOOK_FILLER[0] + " " + BOOK_FILLER[4] + " " +
    BOOK_FILLER[1] + " O prazo conta-se a partir da receção da carta.",
  11: BOOK_FILLER[3] + " A indemnização é calculada nos termos gerais. " + BOOK_FILLER[2],
};

function bookChapterTitle(page: number): string {
  return BOOK_OUTLINE.find((item) => item.page !== null && item.pageEnd !== null && page >= item.page && page <= item.pageEnd)?.title ?? "";
}

function buildBookPageText(page: number): string {
  if (page === 0) return BOOK_BODY[0];
  const header = ((page + 1) % 2 === 0 ? "Manual de Contratos" : bookChapterTitle(page)).padEnd(BOOK_LINE, " ");
  const body = BOOK_BODY[page] ?? `${BOOK_FILLER[page % BOOK_FILLER.length]} ${BOOK_FILLER[(page + 2) % BOOK_FILLER.length]}`;
  const bodyLines = Math.ceil(body.length / BOOK_LINE);
  // Footer on its own grid line, a few lines below the body.
  return `${header}${body.padEnd((bodyLines + 2) * BOOK_LINE, " ")}Página ${page + 1} de ${BOOK_PAGE_COUNT}`;
}

function createBookDocState(): MockDoc {
  const pages: MockPageState[] = Array.from({ length: BOOK_PAGE_COUNT }, () => ({ width: 612, height: 792, rotation: 0 }));
  const pageText = pages.map((_, i) => buildBookPageText(i));
  const mutable: MutableDocState = { pages, pageText, annotations: [], formFields: [], textRuns: [], redactedRects: [] };
  return {
    docId: BOOK_DOC_ID,
    kind: "book",
    path: "",
    encrypted: false,
    hasForm: false,
    isOpen: false,
    revision: 0,
    savedAtDepth: 0,
    undoStack: [],
    redoStack: [],
    baseline: cloneMutable(mutable),
    outline: BOOK_OUTLINE,
    mutable,
  };
}

/** Grid width the mock text layout uses — the book doc pads its header/footer to whole lines of it. */
export const MOCK_CHARS_PER_LINE = BOOK_LINE;

const registry: Record<DocKind, MockDoc> = {
  text: createTextDocState(),
  form: createFormDocState(),
  perf: createPerfDocState(),
  book: createBookDocState(),
};

export function findDocById(docId: string): MockDoc | undefined {
  return Object.values(registry).find((doc) => doc.docId === docId);
}

export function listOpenDocs(): MockDoc[] {
  return Object.values(registry).filter((doc) => doc.isOpen);
}

/**
 * doc_open path-matching convention (documented, CONTRACTS leaves this to
 * the implementer): the path is lower-cased and matched by substring —
 * containing "500" or "perf" opens the fake 500-page document, containing
 * "form" opens the fake form document, containing "text" (or being empty)
 * opens the fake text document, anything else is genuinely unmapped and
 * yields NOT_FOUND. This lets a caller pick a document with an obvious,
 * memorable path ("demo-text.pdf", "demo-form.pdf", "demo-500-pages.pdf")
 * while still exercising the not-found error path for anything else.
 */
export function resolveDocKindFromPath(path: string): DocKind | null {
  const normalized = path.trim().toLowerCase();
  if (normalized.includes("book")) return "book";
  if (normalized.includes("500") || normalized.includes("perf")) return "perf";
  if (normalized.includes("form")) return "form";
  if (normalized.includes("text") || normalized.length === 0) return "text";
  return null;
}

export function openDocByPath(path: string): MockDoc | null {
  const kind = resolveDocKindFromPath(path);
  if (!kind) return null;
  const doc = registry[kind];
  doc.path = path;
  doc.isOpen = true;
  return doc;
}

export function computeDirty(doc: MockDoc): boolean {
  return doc.undoStack.length !== doc.savedAtDepth;
}

export function getDocInfo(doc: MockDoc): DocInfo {
  const pages: PageSize[] = doc.mutable.pages.map((page) => {
    const swapped = page.rotation % 180 !== 0;
    return { width: swapped ? page.height : page.width, height: swapped ? page.width : page.height };
  });
  return {
    docId: doc.docId,
    path: doc.path,
    pageCount: doc.mutable.pages.length,
    pages,
    encrypted: doc.encrypted,
    dirty: computeDirty(doc),
    revision: doc.revision,
    hasForm: doc.hasForm,
  };
}

function emitDocStateChanged(doc: MockDoc, invalidatedPages: number[]): void {
  void docStateChanged.emit({
    docId: doc.docId,
    revision: doc.revision,
    dirty: computeDirty(doc),
    invalidatedPages,
  });
}

/**
 * Runs `mutate` (which performs the change in place and returns the pages
 * it invalidated), snapshots before/after for undo/redo, bumps `revision`,
 * clears the redo stack, and emits `doc_state_changed`. Every annotation /
 * page / form / textedit / redact mutation command goes through this so
 * revision math and undo bookkeeping can never drift between domains.
 */
export function commitMutation(doc: MockDoc, mutate: () => number[]): MutationResult {
  const before = cloneMutable(doc.mutable);
  const invalidatedPages = mutate();
  const after = cloneMutable(doc.mutable);
  doc.undoStack.push({ before, after, invalidatedPages });
  doc.redoStack = [];
  doc.revision += 1;
  emitDocStateChanged(doc, invalidatedPages);
  return { revision: doc.revision, invalidatedPages };
}

/** Returns `null` if there was nothing to undo (callers treat that as a no-op, not an error). */
export function undoDoc(doc: MockDoc): MutationResult | null {
  const entry = doc.undoStack.pop();
  if (!entry) return null;
  doc.mutable = cloneMutable(entry.before);
  doc.redoStack.push(entry);
  doc.revision += 1;
  emitDocStateChanged(doc, entry.invalidatedPages);
  return { revision: doc.revision, invalidatedPages: entry.invalidatedPages };
}

/** Returns `null` if there was nothing to redo (callers treat that as a no-op, not an error). */
export function redoDoc(doc: MockDoc): MutationResult | null {
  const entry = doc.redoStack.pop();
  if (!entry) return null;
  doc.mutable = cloneMutable(entry.after);
  doc.undoStack.push(entry);
  doc.revision += 1;
  emitDocStateChanged(doc, entry.invalidatedPages);
  return { revision: doc.revision, invalidatedPages: entry.invalidatedPages };
}

export function closeDoc(doc: MockDoc): void {
  if (computeDirty(doc)) {
    doc.mutable = cloneMutable(doc.baseline);
    doc.undoStack = [];
    doc.redoStack = [];
    doc.savedAtDepth = 0;
    doc.revision += 1;
    emitDocStateChanged(
      doc,
      doc.mutable.pages.map((_, i) => i),
    );
  }
  doc.isOpen = false;
}

/** Simulates the dirty -> saving -> saved lifecycle with a small artificial delay, and marks the undo depth as the new "clean" point. */
export async function saveDoc(doc: MockDoc): Promise<void> {
  void saveState.emit({ docId: doc.docId, state: "saving" });
  await wait(120);
  doc.baseline = cloneMutable(doc.mutable);
  doc.savedAtDepth = doc.undoStack.length;
  void saveState.emit({ docId: doc.docId, state: "saved" });
  emitDocStateChanged(doc, []);
}

/** Adds `delta` to the `page` field of every piece of per-page data at or after `at` (used by page insert/delete). */
export function shiftPagesFrom(state: MutableDocState, at: number, delta: number): void {
  for (const annot of state.annotations) if (annot.page >= at) annot.page += delta;
  for (const field of state.formFields) if (field.page >= at) field.page += delta;
  for (const run of state.textRuns) if (run.page >= at) run.page += delta;
  for (const region of state.redactedRects) if (region.page >= at) region.page += delta;
}

export function allPageIndices(doc: MockDoc): number[] {
  return doc.mutable.pages.map((_, i) => i);
}
