#!/usr/bin/env node
// fixtures/generate.mjs
//
// Deterministically generates the Rubrica fixtures corpus (CONTRACTS.md §9) using
// pdf-lib. Run `node fixtures/generate.mjs` (wired as `pnpm fixtures:generate`).
//
// Writes, into fixtures/:
//   text.pdf       - multi-page, text-first document with real paragraphs
//   unicode.pdf    - Portuguese-language text with full PT accent coverage
//   500-page.pdf   - exactly 500 pages, minimal per-page content
//   form.pdf       - AcroForm with text/checkbox/radio/dropdown fields
//   scanned.pdf    - single embedded raster image, NO text layer at all
//   corrupt.pdf    - text.pdf deliberately damaged (see fixtures/README.md)
//   book.pdf             - 40-page pt-PT "Manual de Contratos" with a real outline, running
//                          headers/footers and controlled search zones (search v2 ground truth)
//   book-no-outline.pdf  - the same pages without /Outlines
//   book.expected.json   - source of truth for book.pdf's tests, computed from what is drawn
//
// Two more fixtures that pdf-lib cannot produce on its own (encryption) are
// generated separately by fixtures/gen-encrypted.py — see fixtures/README.md.
//
// fixtures/smoke/tiny.pdf is a separate, hand-built fixture for the Rust pdfium
// smoke test (src-tauri/tests/pdfium_smoke.rs) and is NOT touched by this script.
//
// Everything here is deterministic: no Date.now(), no Math.random(), no
// wall-clock timestamps written into PDF metadata (pdf-lib's default
// creation/modification dates are explicitly pinned below) — re-running this
// script produces byte-for-byte identical output.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PDFDocument,
  PDFHexString,
  PDFName,
  StandardFonts,
  beginText,
  endText,
  moveText,
  rgb,
  setFillingColor,
  setFontAndSize,
  showText,
} from 'pdf-lib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = __dirname;

// Pinned so regenerating the corpus never produces a spurious diff.
const FIXED_DATE = new Date('2026-01-01T00:00:00Z');

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 72;

function withDates(doc) {
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer('Rubrica fixtures/generate.mjs');
  doc.setCreator('Rubrica fixtures/generate.mjs');
  return doc;
}

/** Greedy word-wrap: splits `text` into lines no wider than maxWidth at `size`. */
function wrapText(text, font, size, maxWidth) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    const trial = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(trial, size) > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = trial;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/**
 * Flows `blocks` (each `{ text, heading? }`) across as many pages as needed,
 * word-wrapping body text and drawing headings in a larger bold-ish size.
 * Returns the PDFDocument's final page count.
 */
function flowBlocks(pdfDoc, blocks, { bodyFont, headingFont, bodySize = 12, headingSize = 16 }) {
  const maxWidth = PAGE_WIDTH - MARGIN * 2;
  const bodyLineHeight = bodySize * 1.4;
  const headingLineHeight = headingSize * 1.4;
  const paragraphGap = bodySize * 0.9;

  let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;

  const ensureSpace = (needed) => {
    if (y - needed < MARGIN) {
      page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };

  for (const block of blocks) {
    if (block.heading) {
      ensureSpace(headingLineHeight + bodyLineHeight);
      page.drawText(block.heading, {
        x: MARGIN,
        y: y - headingSize,
        size: headingSize,
        font: headingFont,
        color: rgb(0.1, 0.1, 0.12),
      });
      y -= headingLineHeight + headingSize * 0.3;
    }

    const lines = wrapText(block.text, bodyFont, bodySize, maxWidth);
    for (const line of lines) {
      ensureSpace(bodyLineHeight);
      page.drawText(line, {
        x: MARGIN,
        y: y - bodySize,
        size: bodySize,
        font: bodyFont,
        color: rgb(0.15, 0.15, 0.15),
      });
      y -= bodyLineHeight;
    }
    y -= paragraphGap;
  }

  return pdfDoc.getPageCount();
}

// --- text.pdf ----------------------------------------------------------------
//
// Original filler content (not derived from any real document) about a
// fictional "Rubrica Field Guide", written to be representative of a normal
// multi-paragraph document someone would open, read, search, and select text
// in. Sectioned with headings to exercise a couple of font sizes.

const TEXT_PDF_BLOCKS = [
  {
    heading: 'The Rubrica Field Guide',
    text: 'This booklet is a fictional reference document generated purely as a test fixture. It exists to give the viewer, the search index, and the text-selection layer something realistic to chew on: ordinary paragraphs, section headings, and enough pages that scrolling and pagination behave the way they would for a document a person actually opens.',
  },
  {
    heading: '1. Opening a document',
    text: 'When a file is opened, the application reads just enough of it to describe its shape: how many pages it has, how large each page is, and whether it carries a form or requires a password. The rest of the content loads lazily, tile by tile, so a document with hundreds of pages feels no heavier to open than one with three.',
  },
  {
    text: 'Recently opened files are remembered locally, together with the page and zoom level you left off at, so returning to a long report the next morning drops you back exactly where you stopped reading the night before, without any extra clicking.',
  },
  {
    heading: '2. Reading and searching',
    text: 'Selecting text should feel the same as selecting text anywhere else: click and drag across a sentence, double-click a word, triple-click a paragraph. Under the hood this relies on a per-page text layer that maps every visible character back to a precise rectangle, which is also what powers copy-and-paste and the search highlighter.',
  },
  {
    text: 'Search results stream in as they are found rather than waiting for the whole document to be scanned first. On a short document this difference is invisible; on a long one it means the first match appears almost immediately instead of after several seconds of silence.',
  },
  {
    heading: '3. Annotating a page',
    text: 'Highlights, underlines, and strikeouts attach to the text they cover using quadrilateral points, the same mechanism every standard PDF reader understands. A sticky note is simpler still: a single anchor point and a block of text that only appears when the reader opens it.',
  },
  {
    text: 'Freehand ink strokes and shapes are stored as a sequence of points rather than a picture, which keeps the file small and the marks crisp at any zoom level. None of these tools modify the words underneath the mark; they sit on top, exactly like a real pen on real paper.',
  },
  {
    heading: '4. Editing the page order',
    text: 'A document is rarely finished in the order it was scanned or exported. Pages can be dragged into a new order, rotated a quarter turn at a time, deleted outright, or inserted blank or from another file entirely. Every one of these operations can be undone, one step at a time, for as long as the document stays open.',
  },
  {
    heading: '5. Filling in a form',
    text: 'Government forms, applications, and questionnaires typically arrive as a page of labelled boxes: a name field here, a checkbox there, a small group of mutually exclusive radio buttons further down, sometimes a dropdown list of districts or categories. Filling one in should feel like filling in a web form, not like drawing text boxes by hand.',
  },
  {
    heading: '6. A closing note on portability',
    text: 'Every change this application makes is expressed using constructs that any standards-compliant PDF reader already understands: standard annotation types, standard form fields, standard page content streams. A file saved here should look identical whether it is reopened in this application, in a browser, or on a phone six months later.',
  },
  {
    text: 'That portability guarantee is the actual acceptance test behind every feature described above: an edit that only looks right in one particular viewer is treated as a defect, not a curiosity, regardless of how convenient it was to implement.',
  },
  {
    heading: '7. Whiteout versus redaction',
    text: 'These two tools look similar at a glance and are treated very differently underneath. Whiteout paints an opaque shape over a region of the page; the words underneath still exist in the file, they are simply covered up, the same way a piece of correction tape covers ink on real paper without removing it.',
  },
  {
    text: 'True redaction goes further: it removes the underlying text and image objects entirely and replaces the region with a flat rasterized block, so there is nothing left to recover by selecting, copying, or opening the file in a different tool. Choosing the wrong one of these two tools has real consequences, which is why the interface never lets the distinction blur.',
  },
  {
    heading: '8. Editing text in place',
    text: 'Occasionally a single typo or an outdated figure needs correcting without retyping an entire page. Editing a run of text in place reuses the original embedded font whenever it is available and usable, and falls back to a substitute font only when it has no other choice, flagging that substitution visibly rather than silently changing the look of the page.',
  },
  {
    text: 'This kind of in-place editing deliberately does not reflow surrounding paragraphs the way a word processor would. A PDF page is a fixed layout, not a flowing one, and preserving that fixed layout is treated as a feature rather than a limitation to work around.',
  },
  {
    heading: '9. Printing and multiple documents',
    text: 'Printing renders the requested pages at a chosen resolution ahead of time, so the print dialog shows exactly what will land on paper rather than a live, possibly slower, preview. Several documents can stay open at once in separate tabs, each with its own undo history, its own zoom level, and its own save state, entirely independent of the others.',
  },
  {
    heading: '10. Working without a network connection',
    text: 'None of the behaviour described in this guide depends on a network connection. Opening a file, editing it, filling in a form, saving it back to disk — every one of these operations happens entirely on the machine in front of you. The only feature that ever reaches out to the network is the optional update check, and even that can be switched off entirely.',
  },
  {
    heading: '11. A note on recents and preferences',
    text: 'The list of recently opened documents, along with the page and zoom level each one was left at, is kept in a small local database rather than inside the documents themselves. Clearing that list, or turning off the feature entirely, never touches the underlying files: it only forgets where you were, not what you did.',
  },
  {
    text: 'Preferences follow the same rule. A setting such as a default zoom level or a preferred theme is stored once, locally, and applied the next time the application starts, without ever being written into a document or transmitted anywhere.',
  },
];

async function generateTextPdf() {
  const doc = withDates(await PDFDocument.create());
  const bodyFont = await doc.embedFont(StandardFonts.Helvetica);
  const headingFont = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle('The Rubrica Field Guide (fixture)');
  doc.setAuthor('Rubrica fixtures');
  doc.setLanguage('en');

  const pageCount = flowBlocks(doc, TEXT_PDF_BLOCKS, { bodyFont, headingFont });

  const bytes = await doc.save();
  const outPath = path.join(OUT_DIR, 'text.pdf');
  await writeFile(outPath, bytes);
  return { name: 'text.pdf', pages: pageCount, bytes: bytes.length };
}

// --- unicode.pdf ---------------------------------------------------------------
//
// Portuguese-language prose (original, written for this fixture) with full
// European Portuguese accent coverage plus a few non-ASCII punctuation marks
// (em dash, curly single/double quotes). All of these characters ARE
// representable in pdf-lib's default WinAnsiEncoding for its standard fonts
// (Windows-1252 covers the full Latin-1 accented range plus the "smart"
// punctuation block at 0x91-0x97) — so this fixture needs no font embedding
// or @pdf-lib/fontkit dependency. If a future accent set falls outside
// WinAnsi, embedding a custom font via fontkit is the documented fallback
// (see fixtures/README.md).

const UNICODE_PDF_BLOCKS = [
  {
    heading: 'Ficheiro de teste — acentuação',
    text: 'Este documento é um exemplo sintético, gerado apenas para testes, escrito em português europeu. O objetivo é reunir, num único parágrafo, uma boa amostra de caracteres acentuados e de pontuação especial, para verificar mais tarde a extração e a apresentação de texto.',
  },
  {
    text: 'A digitalização de documentos tornou-se, com toda a razão, uma prioridade nas instituições públicas e privadas — da câmara municipal ao pequeno escritório de contabilidade. Já não basta imprimir e arquivar em papel; é preciso avançar com confiança, garantindo a preservação da informação a longo prazo sem perder a formatação original. Ainda assim, há sempre quem diga: “só confio mesmo é no papel”. A verdade é mais matizada: um único PDF bem construído aproxima-se bastante da robustez do papel, com a vantagem de poder ser pesquisado, assinado e arquivado eletronicamente.',
  },
  {
    text: 'Órgãos como tribunais, hospitais e câmaras municipais dependem, por diversas razões, cada vez mais destes sistemas para a gestão do dia a dia — da emissão de certidões à análise de um elevado número de processos, a que alguns chamam, de forma um pouco injusta, de ‘arquivo morto’. A transição exige atenção à acessibilidade, à autenticação e à política de preservação da formatação — três pilares que qualquer aplicação séria de edição de PDF deve respeitar, do início ao fim.',
  },
];

async function generateUnicodePdf() {
  const doc = withDates(await PDFDocument.create());
  const bodyFont = await doc.embedFont(StandardFonts.Helvetica);
  const headingFont = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle('Ficheiro de teste — acentuação (fixture)');
  doc.setAuthor('Rubrica fixtures');
  doc.setLanguage('pt-PT');

  const pageCount = flowBlocks(doc, UNICODE_PDF_BLOCKS, { bodyFont, headingFont });

  const bytes = await doc.save();
  const outPath = path.join(OUT_DIR, 'unicode.pdf');
  await writeFile(outPath, bytes);
  return { name: 'unicode.pdf', pages: pageCount, bytes: bytes.length };
}

// --- 500-page.pdf --------------------------------------------------------------
//
// Exactly 500 pages, minimal per-page content (a single page-number label) —
// this exists to stress tiling/virtualization, not content richness, so
// generation stays fast and the file stays small.

const PAGE_STRESS_COUNT = 500;

async function generate500PagePdf() {
  const doc = withDates(await PDFDocument.create());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('500-page stress fixture');
  doc.setAuthor('Rubrica fixtures');

  for (let i = 1; i <= PAGE_STRESS_COUNT; i++) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    page.drawText(`Page ${i} of ${PAGE_STRESS_COUNT}`, {
      x: MARGIN,
      y: PAGE_HEIGHT - MARGIN,
      size: 20,
      font,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  const bytes = await doc.save();
  const outPath = path.join(OUT_DIR, '500-page.pdf');
  await writeFile(outPath, bytes);
  return { name: '500-page.pdf', pages: doc.getPageCount(), bytes: bytes.length };
}

// --- form.pdf --------------------------------------------------------------------
//
// A real-ish government-style AcroForm: "Formulário de Identificação" with a
// mix of field kinds (text, checkbox, radio group, dropdown) laid out like an
// actual form rather than a bare field showcase.

async function generateFormPdf() {
  const doc = withDates(await PDFDocument.create());
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  doc.setTitle('Formulário de Identificação (fixture)');
  doc.setAuthor('Rubrica fixtures');
  doc.setLanguage('pt-PT');

  const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const form = doc.getForm();

  let y = PAGE_HEIGHT - MARGIN;
  const labelSize = 11;
  const lineGap = 46;

  const drawLabel = (text) => {
    page.drawText(text, { x: MARGIN, y, size: labelSize, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
  };

  page.drawText('Formulário de Identificação', {
    x: MARGIN,
    y,
    size: 20,
    font: boldFont,
    color: rgb(0.1, 0.1, 0.12),
  });
  y -= lineGap;

  // -- Nome (text field) --
  drawLabel('Nome completo');
  const nomeField = form.createTextField('identificacao.nome');
  nomeField.setText('');
  nomeField.addToPage(page, { x: MARGIN, y: y - 22, width: PAGE_WIDTH - MARGIN * 2, height: 20, font });
  y -= lineGap + 12;

  // -- Data de nascimento (text field) --
  drawLabel('Data de nascimento (dd/mm/aaaa)');
  const dataField = form.createTextField('identificacao.dataNascimento');
  dataField.setText('');
  dataField.addToPage(page, { x: MARGIN, y: y - 22, width: 160, height: 20, font });
  y -= lineGap + 12;

  // -- Estado civil (radio group) --
  drawLabel('Estado civil');
  const estadoCivil = form.createRadioGroup('identificacao.estadoCivil');
  const estadoCivilOptions = ['Solteiro(a)', 'Casado(a)', 'Divorciado(a)', 'Viúvo(a)'];
  let optX = MARGIN;
  for (const option of estadoCivilOptions) {
    estadoCivil.addOptionToPage(option, page, { x: optX, y: y - 24, width: 14, height: 14 });
    page.drawText(option, { x: optX + 20, y: y - 22, size: 10, font, color: rgb(0.15, 0.15, 0.15) });
    optX += 110;
  }
  y -= lineGap + 12;

  // -- Distrito (dropdown) --
  drawLabel('Distrito');
  const distrito = form.createDropdown('identificacao.distrito');
  distrito.addOptions(['Aveiro', 'Braga', 'Coimbra', 'Faro', 'Lisboa', 'Porto', 'Setúbal', 'Viseu']);
  distrito.select('Lisboa');
  distrito.addToPage(page, { x: MARGIN, y: y - 22, width: 200, height: 20, font });
  y -= lineGap + 12;

  // -- Aceito os termos (checkbox) --
  const aceito = form.createCheckBox('identificacao.aceitoTermos');
  aceito.addToPage(page, { x: MARGIN, y: y - 20, width: 14, height: 14 });
  page.drawText('Aceito os termos e condições', {
    x: MARGIN + 20,
    y: y - 18,
    size: 11,
    font,
    color: rgb(0.15, 0.15, 0.15),
  });
  y -= lineGap;

  page.drawText('(Documento gerado automaticamente para fins de teste.)', {
    x: MARGIN,
    y: MARGIN,
    size: 8,
    font,
    color: rgb(0.5, 0.5, 0.5),
  });

  const bytes = await doc.save();
  const outPath = path.join(OUT_DIR, 'form.pdf');
  await writeFile(outPath, bytes);
  return { name: 'form.pdf', pages: doc.getPageCount(), bytes: bytes.length };
}

// --- scanned.pdf -----------------------------------------------------------------
//
// A single embedded raster image and NOTHING else — no text objects, no
// fonts, no text layer at all — simulating a scanned document. The source
// image (fixtures/scanned-source.png) is produced once by the dependency-free
// fixtures/gen-scanned-source.py (same hand-rolled-PNG technique as
// scripts/gen-placeholder-icon.py) and committed, so building this fixture
// via `pnpm fixtures:generate` never requires Python at generation time.

async function generateScannedPdf() {
  const doc = withDates(await PDFDocument.create());
  doc.setTitle('Scanned document (fixture)');
  doc.setAuthor('Rubrica fixtures');

  const pngPath = path.join(OUT_DIR, 'scanned-source.png');
  const pngBytes = await readFile(pngPath);
  const image = await doc.embedPng(pngBytes);

  // US-Letter-ratio page sized to the source image's own aspect ratio so it
  // fills the page edge-to-edge, the way a scanner driver would emit it.
  const page = doc.addPage([image.width / 2.5, image.height / 2.5]); // ~200dpi -> 72dpi points
  page.drawImage(image, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });

  const bytes = await doc.save();
  const outPath = path.join(OUT_DIR, 'scanned.pdf');
  await writeFile(outPath, bytes);
  return { name: 'scanned.pdf', pages: doc.getPageCount(), bytes: bytes.length };
}

// --- corrupt.pdf -----------------------------------------------------------------
//
// See fixtures/README.md for the exact rationale. Summary: take the
// already-written text.pdf and truncate it partway through its object
// stream section — well past the header and the first several complete
// objects, but before the xref table / trailer / %%EOF. The header and
// early indirect objects (catalog, pages tree, first content stream bytes)
// stay byte-for-byte intact, so a naive byte-level scan gets partway before
// running out of file; pdf-lib's loader has no trailer to locate the
// document root from and — because the file also ends mid-object rather
// than on a clean object boundary — its xref-recovery scan cannot rebuild a
// usable structure either, so `PDFDocument.load()` reliably throws.

async function generateCorruptPdf() {
  const sourcePath = path.join(OUT_DIR, 'text.pdf');
  const source = await readFile(sourcePath);

  const cutPoint = Math.floor(source.length * 0.35);
  const truncated = source.subarray(0, cutPoint);

  const outPath = path.join(OUT_DIR, 'corrupt.pdf');
  await writeFile(outPath, truncated);
  return { name: 'corrupt.pdf', pages: 'n/a (truncated)', bytes: truncated.length };
}

// --- book.pdf / book-no-outline.pdf / book.expected.json -------------------------
//
// A 40-page pt-PT "Manual de Contratos": ground truth for search v2 (proximity
// search, scope by chapter, header/footer exclusion, accent-insensitive matching).
// Written line by line (NOT via flowBlocks) so we know exactly which line lands on
// which page. Everything drawn is recorded as it is laid out, and every count in
// book.expected.json is computed from those recorded strings — nothing is tallied
// by hand. See fixtures/README.md for what each controlled zone is for.

const BOOK_PAGE_COUNT = 40;
const BOOK_TITLE = 'Manual de Contratos';
const BOOK_BODY_SIZE = 11;
const BOOK_LINE_HEIGHT = 15.4;
const BOOK_TOP_BASELINE = 712; // slot 0 baseline; glyph tops stay below y=729 (top 8% band)
const BOOK_SLOTS = 41; // slot 40 baseline = 96
const BOOK_HEADER_Y = 752;
const BOOK_FOOTER_Y = 30;
const BOOK_MAX_WIDTH = PAGE_WIDTH - MARGIN * 2; // 468

// Chapters (1-based pages). `page` of an entry = page where its heading line is drawn.
const BOOK_CHAPTERS = [
  {
    title: '1 Introdução',
    page: 2,
    subs: [
      { title: '1.1 Âmbito', page: 2 },
      { title: '1.2 Definições', page: 5 },
    ],
  },
  {
    title: '2 Formação do contrato',
    page: 9,
    subs: [
      { title: '2.1 Proposta', page: 9 },
      { title: '2.2 Aceitação', page: 12 },
      { title: '2.3 Forma', page: 14 },
    ],
  },
  {
    title: '3 Cessação do contrato',
    page: 16,
    subs: [
      { title: '3.1 Por acordo', page: 16 },
      {
        title: '3.2 Por incumprimento',
        page: 17,
        slot: 6,
        subs: [{ title: '3.2.1 Incumprimento definitivo', page: 19 }],
      },
      { title: '3.3 Efeitos', page: 21 },
    ],
  },
  {
    title: '4 Prazos e notificações',
    page: 24,
    subs: [
      { title: '4.1 Contagem de prazos', page: 24 },
      { title: '4.2 Notificações', page: 28 },
    ],
  },
  {
    title: '5 Disposições finais',
    page: 32,
    subs: [
      { title: '5.1 Lei aplicável', page: 32 },
      { title: '5.2 Foro', page: 36, slot: 6 },
    ],
  },
];

// Pages 35-37 are deliberately short (see fixtures/README.md): it keeps the two decoy terms on
// p.34 and p.38 within ~3,600 characters of each other, so a 5000-char window across pages
// joins them while a 500-char window does not.
const BOOK_SHORT_PAGES = { 35: 12, 36: 14, 37: 12 };

const BOOK_TIGHT_TRIO_TEXT =
  'Em caso de falta grave, a parte lesada pode invocar a rescisão por carta registada dirigida à outra parte, ' +
  'fixando o novo prazo razoável para a reparação e exigindo a indemnização devida, sem outras formalidades.';
const BOOK_LOOSE_TRIO_TEXT =
  'Verificada a falta, a parte interessada pode optar pela rescisão, desde que o faça por escrito ' +
  'e indique com clareza o fundamento invocado perante a outra parte. A comunicação deve ser enviada ' +
  'para a morada que consta do registo e conservada em arquivo. ' +
  'Quando seja fixado um novo prazo, este começa a correr no dia seguinte ao da receção da carta, ' +
  'e a parte faltosa pode ainda pedir esclarecimentos sobre o montante da respetiva indemnização.';

// Fixed (hand-written) content, keyed by 1-based page. `slot` = first line slot; a `paragraph`
// is wrapped by the generator, `lines` are drawn exactly as given.
const BOOK_FIXED = {
  4: [{ slot: 14, lines: ['Qualquer ação judicial relativa a esta matéria deve ser proposta no foro competente.'] }],
  11: [{ slot: 20, lines: ['A ação de cumprimento só pode ser intentada depois de esgotados os meios amigáveis.'] }],
  17: [{ slot: 15, paragraph: BOOK_TIGHT_TRIO_TEXT, zone: 'tightTrio' }],
  18: [
    {
      slot: 8,
      lines: ['O incumprimento só releva quando constitua “justa causa”, nos termos do art. 12.º do código.'],
      zone: 'quotesNbsp',
    },
  ],
  20: [{ slot: 9, lines: ['Nenhuma ação ou omissão da parte faltosa suspende os efeitos da declaração enviada.'] }],
  22: [{ slot: 40, lines: ['Quando for esse o caso, a parte que pretenda fazer cessar'], zone: 'crossPageEnd' }],
  23: [
    {
      slot: 0,
      lines: ['o acordo deve comunicá-lo por escrito à outra parte, indicando o fundamento invocado.'],
      zone: 'crossPageStart',
    },
  ],
  25: [
    {
      slot: 10,
      lines: [
        'A parte notificada deve cumprir o que ficou estabelecido no presente contra-',
        'to, salvo se a outra parte aceitar por escrito uma solução alternativa.',
      ],
      zone: 'hyphenContrato',
    },
    {
      slot: 20,
      lines: [
        'O destinatário pode apresentar a sua resposta até ao final do pré-',
        'aviso acordado entre as partes, sem qualquer outra formalidade.',
      ],
      zone: 'hyphenPreAviso',
    },
  ],
  26: [
    {
      slot: 10,
      lines: [
        'As partes comprometem-se a cumprir todas as obriga­',
        'ções assumidas, sem prejuízo do disposto na cláusula seguinte.',
      ],
      zone: 'softHyphen',
    },
  ],
  27: [
    {
      slot: 10,
      lines: ['A eﬁcácia do mecanismo e o ﬂuxo das comunicações dependem da boa fé das partes.'],
      zone: 'ligatures',
      ligatures: true,
    },
  ],
  30: [{ slot: 14, paragraph: BOOK_LOOSE_TRIO_TEXT, zone: 'looseTrio' }],
  33: [{ slot: 18, lines: ['A ação de anulação caduca se não for proposta dentro do período legal aplicável.'] }],
  34: [
    {
      slot: 38,
      paragraph: 'A parte interessada pode invocar a rescisão por carta registada dirigida à outra parte.',
      zone: 'decoyRescisao',
    },
  ],
  38: [
    {
      slot: 3,
      paragraph: 'A parte lesada tem direito à indemnização pelos danos que comprove ter sofrido.',
      zone: 'decoyIndemnizacao',
    },
  ],
};

// Vocabulary (pt-PT). Deliberately excludes: contratos/contratual, prazo(s), rescisão,
// indemnização, ação, obrigações, eficácia, fluxo, aviso, pré, fazer, cessar, justa — those only
// occur in the controlled zones / headings. `contrato` is listed three times so it has a ~1.5%
// share of the words.
const BOOK_VOCAB = [
  'parte', 'partes', 'cláusula', 'cláusulas', 'notificação', 'código', 'período', 'prestação',
  'responsável', 'órgão', 'já', 'até', 'execução', 'decisão', 'garantia', 'direitos', 'deveres',
  'compromissos', 'documento', 'documentos', 'declaração', 'comunicação', 'entidade', 'tribunal',
  'juízo', 'acordo', 'vontade', 'forma', 'escrita', 'assinatura', 'representante', 'mandatário',
  'sociedade', 'empresa', 'cliente', 'fornecedor', 'serviço', 'serviços', 'bem', 'bens', 'preço',
  'pagamento', 'fatura', 'entrega', 'mora', 'cumprimento', 'falta', 'dano', 'danos', 'risco',
  'seguro', 'caução', 'penalidade', 'valor', 'quantia', 'montante', 'data', 'momento', 'local',
  'domicílio', 'morada', 'correio', 'registo', 'carta', 'meio', 'prova', 'testemunha', 'perito',
  'árbitro', 'arbitragem', 'mediação', 'conciliação', 'procedimento', 'processo', 'requisito',
  'condição', 'condições', 'termo', 'termos', 'efeito', 'efeitos', 'regime', 'regra', 'regras',
  'norma', 'normas', 'lei', 'legislação', 'princípio', 'interpretação', 'integração', 'omissão',
  'erro', 'dolo', 'coação', 'simulação', 'nulidade', 'anulabilidade', 'invalidade', 'validade',
  'vigência', 'duração', 'renovação', 'denúncia', 'revogação', 'resolução', 'suspensão', 'cessão',
  'transmissão', 'sucessão', 'herdeiros', 'credor', 'devedor', 'garante', 'fiador', 'terceiro',
  'terceiros', 'interessado', 'interessados', 'autoridade', 'administração', 'gerência',
  'assembleia', 'sócio', 'sócios', 'contrato', 'contrato', 'contrato',
  'deve', 'devem', 'pode', 'podem', 'será', 'serão', 'fica', 'ficam', 'aplica', 'aplicam',
  'exige', 'exigem', 'comunica', 'indica', 'prevê', 'estabelece', 'determina', 'resulta',
  'depende', 'produz', 'mantém', 'cabe', 'compete',
  'de', 'da', 'do', 'das', 'dos', 'em', 'no', 'na', 'nos', 'nas', 'por', 'para', 'com', 'sem',
  'sob', 'sobre', 'entre', 'ao', 'à', 'aos', 'às', 'que', 'se', 'ou', 'e', 'mas', 'quando',
  'desde', 'conforme', 'segundo', 'mediante', 'perante', 'nomeadamente', 'designadamente',
  'igualmente', 'sempre', 'apenas', 'ainda', 'também', 'assim', 'caso', 'salvo', 'exceto',
  'qualquer', 'cada', 'todas', 'todos', 'outro', 'outra', 'mesmo', 'respetiva', 'respetivo',
  'presente', 'anterior', 'seguinte', 'devida', 'devido', 'prévio', 'escrito', 'legal', 'legais',
  'necessário', 'necessária', 'comum', 'mútuo',
];

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bookSentence(rng) {
  const n = 8 + Math.floor(rng() * 9);
  const words = [];
  for (let i = 0; i < n; i++) {
    let w;
    do {
      w = BOOK_VOCAB[Math.floor(rng() * BOOK_VOCAB.length)];
      // A capitalised sentence-initial `Contrato` would blur the body/title counts.
    } while (i === 0 && w === 'contrato');
    words.push(w);
  }
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(' ') + '.';
}

const WORD_CHAR = '[\\p{L}\\p{N}]';
const wholeWordRe = (w, flags = 'gu') => new RegExp(`(?<!${WORD_CHAR})${w}(?!${WORD_CHAR})`, flags);
const countWhole = (text, w, flags = 'gu') => (text.match(wholeWordRe(w, flags)) ?? []).length;

const round2 = (n) => Math.round(n * 100) / 100;
const slotY = (slot) => round2(BOOK_TOP_BASELINE - slot * BOOK_LINE_HEIGHT);

/** Top-level chapter containing 1-based page p (undefined for the title page). */
function chapterOfPage(p) {
  let found;
  for (const ch of BOOK_CHAPTERS) if (ch.page <= p) found = ch;
  return found;
}

/**
 * Lays out the whole book into `pages[i] = { number, lines }`, where each line is
 * `{ text, role, font, size, x, y, slot?, zone?, ligatures? }`. Plain data; the only pdf-lib
 * object used is the font, for width metrics while wrapping.
 */
function layoutBook(helv) {
  const pages = [];
  const headings = []; // { title, page (1-based), y (heading top) } in document order

  for (let p = 1; p <= BOOK_PAGE_COUNT; p++) {
    const lines = [];
    pages.push({ number: p, lines });

    if (p === 1) {
      lines.push({ text: BOOK_TITLE, role: 'title', font: 'bold', size: 30, x: MARGIN, y: 470 });
      lines.push({
        text: 'Ficheiro de teste gerado automaticamente',
        role: 'title',
        font: 'regular',
        size: 14,
        x: MARGIN,
        y: 435,
      });
      continue;
    }

    const ch = chapterOfPage(p);
    const headerText = p % 2 === 0 ? BOOK_TITLE : ch.title;
    const footerText = `Página ${p} de ${BOOK_PAGE_COUNT}`;
    const header = { text: headerText, role: 'header', font: 'regular', size: 9, x: MARGIN, y: BOOK_HEADER_Y };
    const footer = {
      text: footerText,
      role: 'footer',
      font: 'regular',
      size: 9,
      x: round2(PAGE_WIDTH / 2 - helv.widthOfTextAtSize(footerText, 9) / 2),
      y: BOOK_FOOTER_Y,
    };

    const slots = BOOK_SHORT_PAGES[p] ?? BOOK_SLOTS;
    const occupied = new Array(slots).fill(false);
    const claim = (slot, n, what) => {
      for (let i = slot; i < slot + n; i++) {
        if (i < 0 || i >= slots || occupied[i]) throw new Error(`book p.${p}: slot ${i} unavailable for ${what}`);
        occupied[i] = true;
      }
    };
    const bodyLines = [];
    const body = (slot, text, extra = {}) =>
      bodyLines.push({ text, role: 'body', font: 'regular', size: BOOK_BODY_SIZE, x: MARGIN, y: slotY(slot), slot, ...extra });
    const heading = (slot, text, size) => {
      bodyLines.push({ text, role: 'heading', font: 'bold', size, x: MARGIN, y: slotY(slot), slot });
      headings.push({ title: text, page: p, y: round2(slotY(slot) + size) });
    };

    // Headings: a blank slot is reserved after the chapter heading and before a mid-page one.
    if (ch.page === p) {
      claim(0, 2, 'chapter heading');
      heading(0, ch.title, 16);
    }
    const subs = [];
    const walk = (list) => {
      for (const s of list) {
        subs.push(s);
        if (s.subs) walk(s.subs);
      }
    };
    walk(ch.subs);
    for (const s of subs.filter((s) => s.page === p)) {
      const slot = s.slot ?? (ch.page === p ? 2 : 12);
      if (slot > 0 && !occupied[slot - 1]) occupied[slot - 1] = true;
      claim(slot, 1, s.title);
      heading(slot, s.title, 12);
    }

    // Fixed content
    for (const f of BOOK_FIXED[p] ?? []) {
      const texts = f.paragraph ? wrapText(f.paragraph, helv, BOOK_BODY_SIZE, BOOK_MAX_WIDTH) : f.lines;
      claim(f.slot, texts.length, f.zone ?? 'fixed');
      texts.forEach((t, i) => {
        if (!f.ligatures && helv.widthOfTextAtSize(t, BOOK_BODY_SIZE) > BOOK_MAX_WIDTH) {
          throw new Error(`book p.${p}: line too wide: ${t}`);
        }
        body(f.slot + i, t, { zone: f.zone, zoneLine: i, ligatures: !!f.ligatures });
      });
    }

    // Filler: contiguous free runs, a blank slot after every 8 lines of text.
    const rng = mulberry32(0xb00c + p * 7919);
    let i = 0;
    while (i < slots) {
      if (occupied[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j < slots && !occupied[j]) j++;
      const runLen = j - i;
      const textSlots = [];
      for (let k = 0; k < runLen; k++) if (!((k + 1) % 9 === 0 && k !== runLen - 1)) textSlots.push(i + k);
      let text = '';
      let wrapped = [];
      while (wrapped.length < textSlots.length) {
        text += (text ? ' ' : '') + bookSentence(rng);
        wrapped = wrapText(text, helv, BOOK_BODY_SIZE, BOOK_MAX_WIDTH);
      }
      textSlots.forEach((slot, idx) => body(slot, wrapped[idx]));
      i = j;
    }

    bodyLines.sort((a, b) => a.slot - b.slot);
    lines.push(header, ...bodyLines, footer);
  }
  return { pages, headings };
}

/** WinAnsi hex for `text`, mapping U+FB01 -> 0x80 and U+FB02 -> 0x81 (see the ligature font). */
function ligatureHex(text, helv) {
  let hex = '';
  let seg = '';
  const flush = () => {
    if (seg) hex += helv.encodeText(seg).value;
    seg = '';
  };
  for (const ch of text) {
    if (ch === 'ﬁ' || ch === 'ﬂ') {
      flush();
      hex += ch === 'ﬁ' ? '80' : '81';
    } else seg += ch;
  }
  flush();
  return hex;
}

/** Hand-built /Outlines tree (pdf-lib has no outline API). Nodes: { title, pageIndex, y, children }. */
function addOutline(doc, pageRefs, nodes) {
  const ctx = doc.context;
  const outlinesRef = ctx.nextRef();
  const refs = new Map();
  const allocate = (list) => {
    for (const n of list) {
      refs.set(n, ctx.nextRef());
      allocate(n.children);
    }
  };
  allocate(nodes);
  const countDescendants = (n) => n.children.reduce((s, c) => s + 1 + countDescendants(c), 0);

  const assign = (list, parentRef) => {
    list.forEach((n, i) => {
      const entries = {
        Title: PDFHexString.fromText(n.title),
        Parent: parentRef,
        Dest: ctx.obj([pageRefs[n.pageIndex], 'XYZ', null, n.y, null]),
      };
      if (i > 0) entries.Prev = refs.get(list[i - 1]);
      if (i < list.length - 1) entries.Next = refs.get(list[i + 1]);
      if (n.children.length) {
        entries.First = refs.get(n.children[0]);
        entries.Last = refs.get(n.children[n.children.length - 1]);
        entries.Count = countDescendants(n);
      }
      ctx.assign(refs.get(n), ctx.obj(entries));
      assign(n.children, refs.get(n));
    });
  };
  assign(nodes, outlinesRef);

  ctx.assign(
    outlinesRef,
    ctx.obj({
      Type: 'Outlines',
      First: refs.get(nodes[0]),
      Last: refs.get(nodes[nodes.length - 1]),
      Count: nodes.reduce((s, n) => s + 1 + countDescendants(n), 0),
    }),
  );
  doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
  doc.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

async function buildBookPdf(layout, { withOutline }) {
  const doc = withDates(await PDFDocument.create());
  doc.setTitle(BOOK_TITLE);
  doc.setLanguage('pt-PT');
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  // Second Helvetica dict: WinAnsi plus /Differences so 0x80 = fi and 0x81 = fl (WinAnsi itself
  // has no U+FB01/U+FB02, and pdf-lib's drawText cannot encode them).
  const ligFontRef = doc.context.register(
    doc.context.obj({
      Type: 'Font',
      Subtype: 'Type1',
      BaseFont: 'Helvetica',
      Encoding: { Type: 'Encoding', BaseEncoding: 'WinAnsiEncoding', Differences: [128, 'fi', 129, 'fl'] },
    }),
  );

  const pageRefs = [];
  for (const pg of layout.pages) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    pageRefs.push(page.ref);
    for (const l of pg.lines) {
      const gray = l.role === 'header' || l.role === 'footer' ? 0.35 : 0.12;
      if (l.ligatures) {
        const tag = page.node.newFontDictionary('FLig', ligFontRef);
        page.pushOperators(
          setFillingColor(rgb(gray, gray, gray)),
          beginText(),
          setFontAndSize(tag, l.size),
          moveText(l.x, l.y),
          showText(PDFHexString.of(ligatureHex(l.text, fonts.regular))),
          endText(),
        );
      } else {
        page.drawText(l.text, { x: l.x, y: l.y, size: l.size, font: fonts[l.font], color: rgb(gray, gray, gray) });
      }
    }
  }

  if (withOutline) {
    const byTitle = new Map(layout.headings.map((h) => [h.title, h]));
    const toNode = (e) => {
      const h = byTitle.get(e.title);
      return { title: e.title, pageIndex: h.page - 1, y: h.y, children: (e.subs ?? []).map(toNode) };
    };
    addOutline(doc, pageRefs, BOOK_CHAPTERS.map(toNode));
  }
  return doc.save();
}

function bookExpected(layout) {
  const allLines = layout.pages.flatMap((pg) => pg.lines.map((l) => ({ ...l, page: pg.number })));
  const countByPage = (roles, word, flags = 'gu') => {
    const byPage = {};
    let total = 0;
    for (const pg of layout.pages) {
      const n = pg.lines.filter((l) => roles.includes(l.role)).reduce((s, l) => s + countWhole(l.text, word, flags), 0);
      if (n) byPage[String(pg.number - 1)] = n;
      total += n;
    }
    return { total, byPage };
  };

  // Outline tree with pageEnd (0-based, inclusive).
  const flat = [];
  const flatten = (list, depth) => {
    for (const e of list) {
      flat.push({ e, depth });
      flatten(e.subs ?? [], depth + 1);
    }
  };
  flatten(BOOK_CHAPTERS, 0);
  const pageEndOf = (idx) => {
    const { depth } = flat[idx];
    for (let k = idx + 1; k < flat.length; k++) {
      if (flat[k].depth <= depth) return flat[k].e.page - 2; // page before it, 0-based
    }
    return BOOK_PAGE_COUNT - 1;
  };
  let cursor = 0;
  const toOutline = (list, depth) =>
    list.map((e) => {
      const idx = cursor++;
      const node = { title: e.title, page: e.page - 1, pageLabel: e.page, pageEnd: pageEndOf(idx), depth, children: [] };
      node.children = toOutline(e.subs ?? [], depth + 1);
      return node;
    });
  const outline = toOutline(BOOK_CHAPTERS, 0);

  const headerByPage = {};
  const oddByChapter = {};
  for (const pg of layout.pages) {
    const h = pg.lines.find((l) => l.role === 'header');
    if (!h) continue;
    headerByPage[String(pg.number - 1)] = h.text;
    if (pg.number % 2 === 1) (oddByChapter[h.text] ??= []).push(pg.number - 1);
  }

  const zoneLines = (zone) => allLines.filter((l) => l.zone === zone);
  const locate = (joined, term) => {
    const m = [...joined.matchAll(wholeWordRe(term, 'gu'))];
    if (m.length !== 1) throw new Error(`expected exactly one "${term}" in: ${joined}`);
    return { term, offset: m[0].index, end: m[0].index + term.length };
  };
  const trio = (zone, min, max) => {
    const ls = zoneLines(zone);
    const joined = ls.map((l) => l.text).join(' ');
    const terms = ['rescisão', 'prazo', 'indemnização'].map((t) => locate(joined, t));
    const start = Math.min(...terms.map((t) => t.offset));
    const end = Math.max(...terms.map((t) => t.end));
    const span = end - start;
    if (span < min || span > max) throw new Error(`${zone} spans ${span} chars, outside [${min}, ${max}]`);
    return {
      page: ls[0].page - 1,
      pageLabel: ls[0].page,
      lines: ls.map((l) => l.text),
      joinedWith: ' ',
      joined,
      terms,
      spanChars: span,
    };
  };
  const tightTrio = { ...trio('tightTrio', 115, 135), foundWithWindow: { 100: false, 250: true, 500: true } };
  const looseTrio = { ...trio('looseTrio', 365, 395), foundWithWindow: { 100: false, 250: false, 500: true } };

  const decoyOne = (zone, term) => {
    const ls = zoneLines(zone);
    locate(ls.map((l) => l.text).join(' '), term);
    return { page: ls[0].page - 1, pageLabel: ls[0].page, lines: ls.map((l) => l.text), term };
  };
  const decoy = {
    rescisao: decoyOne('decoyRescisao', 'rescisão'),
    indemnizacao: decoyOne('decoyIndemnizacao', 'indemnização'),
  };
  {
    // Reading-order text (headers and footers included, lines joined by "\n") between the two.
    const stream = layout.pages
      .slice(decoy.rescisao.page, decoy.indemnizacao.page + 1)
      .flatMap((pg) => pg.lines.map((l) => l.text))
      .join('\n');
    const a = stream.indexOf('rescisão') + 'rescisão'.length;
    const b = stream.indexOf('indemnização');
    decoy.charsBetween = b - a;
    if (decoy.charsBetween <= 500 || decoy.charsBetween >= 5000) {
      throw new Error(`decoy terms are ${decoy.charsBetween} chars apart; need 500 < n < 5000`);
    }
  }

  // Guard rails: the trio words may only occur in the controlled zones (1-based pages).
  const guard = { rescisão: [17, 30, 34], prazo: [17, 30], indemnização: [17, 30, 38] };
  for (const [w, pages] of Object.entries(guard)) {
    const got = layout.pages.filter((pg) => pg.lines.some((l) => countWhole(l.text, w, 'giu'))).map((pg) => pg.number);
    if (JSON.stringify(got) !== JSON.stringify(pages)) throw new Error(`"${w}" on pages ${got}, expected ${pages}`);
  }
  for (const l of allLines) {
    if (countWhole(l.text, 'acao', 'giu')) throw new Error(`unaccented "acao" in: ${l.text}`);
    if (l.role === 'body' && /prazos/i.test(l.text)) throw new Error(`"prazos" in body: ${l.text}`);
  }

  const bodyOf = (page) => layout.pages[page - 1].lines.filter((l) => l.role === 'body');
  const crossEnd = zoneLines('crossPageEnd')[0];
  const crossStart = zoneLines('crossPageStart')[0];
  if (bodyOf(crossEnd.page).at(-1).text !== crossEnd.text || bodyOf(crossStart.page)[0].text !== crossStart.text) {
    throw new Error('cross-page lines are not the last/first body lines');
  }
  const crossPage = {
    fromPage: crossEnd.page - 1,
    toPage: crossStart.page - 1,
    lastLine: crossEnd.text,
    firstLine: crossStart.text,
    phrase: 'fazer cessar o acordo',
    note: 'The page footer and the next page header sit between these two lines in reading order.',
  };

  const hy = (zone, word, forms) => {
    const ls = zoneLines(zone);
    return {
      page: ls[0].page - 1,
      pageLabel: ls[0].page,
      line1: ls[0].text,
      line2: ls[1].text,
      word,
      acceptedForms: forms,
      countedInContratoTotals: false,
    };
  };
  const hyphenated = {
    contrato: hy('hyphenContrato', 'contrato', ['contrato', 'contra-to']),
    preAviso: hy('hyphenPreAviso', 'pré-aviso', ['pré-aviso', 'préaviso']),
  };
  const sh = zoneLines('softHyphen');
  const softHyphen = {
    page: sh[0].page - 1,
    pageLabel: sh[0].page,
    line1: sh[0].text,
    line2: sh[1].text,
    word: 'obrigações',
    drawnCodePoint: 'U+00AD',
  };
  const lg = zoneLines('ligatures')[0];
  const ligatures = {
    page: lg.page - 1,
    pageLabel: lg.page,
    line: lg.text,
    designed: [
      { word: 'eﬁcácia', normalized: 'eficácia', ligature: 'U+FB01' },
      { word: 'ﬂuxo', normalized: 'fluxo', ligature: 'U+FB02' },
    ],
    encoding: 'Type1 Helvetica, WinAnsiEncoding + /Differences [128 /fi 129 /fl]; byte 0x80 = fi, 0x81 = fl',
  };
  const qn = zoneLines('quotesNbsp')[0];
  const quotesNbsp = {
    page: qn.page - 1,
    pageLabel: qn.page,
    line: qn.text,
    quoted: '“justa causa”',
    quotedCodePoints: ['U+201C', 'U+201D'],
    nbspPhrase: 'art. 12.º',
    nbspCodePoint: 'U+00A0',
  };

  const acao = countByPage(['body'], 'ação');
  const contrato = countByPage(['body'], 'contrato');
  if (contrato.total <= 100) throw new Error(`only ${contrato.total} body "contrato"`);
  const inHeadings = countByPage(['heading'], 'contrato', 'giu');
  const inHeaders = countByPage(['header', 'title'], 'contrato', 'giu');

  return {
    pageCount: BOOK_PAGE_COUNT,
    pageSize: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
    outline,
    header: { even: BOOK_TITLE, oddByChapter, byPage: headerByPage, firstPage: 1, baselineY: BOOK_HEADER_Y },
    footer: { pattern: `Página {n} de ${BOOK_PAGE_COUNT}`, firstPage: 1, baselineY: BOOK_FOOTER_Y },
    contrato: {
      total: contrato.total,
      byPage: contrato.byPage,
      note: 'Whole-word lowercase "contrato" in body text only; excludes the hyphenated contra-/to and every heading, running header and title.',
    },
    contratoInTitles: {
      total: inHeadings.total + inHeaders.total,
      headings: inHeadings,
      headers: inHeaders,
      note: 'Whole-word "contrato" (any case) in heading lines and running headers (chapters 2 and 3 carry it in their titles).',
    },
    acaoPages: Object.keys(acao.byPage).map(Number),
    acaoByPage: acao.byPage,
    acaoNote: 'Standalone "ação" only (whole word). Longer words ending in -ação (notificação, prestação, ...) occur throughout the filler.',
    tightTrio,
    looseTrio,
    decoy,
    crossPage,
    hyphenated,
    softHyphen,
    ligatures,
    quotesNbsp,
    shortPages: Object.keys(BOOK_SHORT_PAGES).map((p) => Number(p) - 1),
  };
}

async function generateBookPdfs() {
  const probe = await PDFDocument.create();
  const helv = await probe.embedFont(StandardFonts.Helvetica);
  const layout = layoutBook(helv);

  const withOutline = await buildBookPdf(layout, { withOutline: true });
  const noOutline = await buildBookPdf(layout, { withOutline: false });
  const json = JSON.stringify(bookExpected(layout), null, 2) + '\n';

  await writeFile(path.join(OUT_DIR, 'book.pdf'), withOutline);
  await writeFile(path.join(OUT_DIR, 'book-no-outline.pdf'), noOutline);
  await writeFile(path.join(OUT_DIR, 'book.expected.json'), json);
  return [
    { name: 'book.pdf', pages: BOOK_PAGE_COUNT, bytes: withOutline.length },
    { name: 'book-no-outline.pdf', pages: BOOK_PAGE_COUNT, bytes: noOutline.length },
    { name: 'book.expected.json', pages: 'n/a', bytes: Buffer.byteLength(json) },
  ];
}

// --- main --------------------------------------------------------------------

async function main() {
  const results = [];
  results.push(await generateTextPdf());
  results.push(await generateUnicodePdf());
  results.push(await generate500PagePdf());
  results.push(await generateFormPdf());
  results.push(await generateScannedPdf());
  results.push(await generateCorruptPdf()); // must run after generateTextPdf()
  results.push(...(await generateBookPdfs()));

  console.log('Generated fixtures:');
  for (const r of results) {
    console.log(`  ${r.name.padEnd(14)} ${String(r.pages).padStart(4)} page(s)  ${r.bytes.toLocaleString('en-US')} bytes`);
  }
  console.log('\nNote: encrypted.pdf is generated separately — see fixtures/README.md (fixtures/gen-encrypted.py).');
}

main().catch((err) => {
  console.error('fixtures/generate.mjs failed:', err);
  process.exitCode = 1;
});
