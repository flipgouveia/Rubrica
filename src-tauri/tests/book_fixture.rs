//! F0: checks that PDFium sees `fixtures/book.pdf` (and `book-no-outline.pdf`) exactly as
//! `fixtures/book.expected.json` says it should — the ground truth for search v2 (proximity,
//! scope by chapter, header/footer exclusion, accent-insensitive matching).
//!
//! `book.expected.json` is written by `fixtures/generate.mjs` from the strings it actually draws,
//! so it is the source of truth; this test proves PDFium's *extraction* agrees with it (outline
//! and destinations, running headers/footers and their position bands, per-page whole-word
//! `contrato` counts, and every controlled zone). It also records what PDFium extracts for the
//! soft hyphen, the real ligature glyphs, the NBSP and the curly quotes (printed with
//! `--nocapture`, asserted only loosely because that is PDFium behaviour, not a design target).
//!
//! As in `engine_fixtures.rs` (see its module doc) everything runs from one `#[test]` function on
//! one thread, so the vendored PDFium build only ever sees a single thread identity.
//!
//! Run with: `cargo test --manifest-path src-tauri/Cargo.toml --test book_fixture -- --nocapture`

use std::path::PathBuf;

use pdfium_render::prelude::*;
use serde_json::Value;

fn fixture(name: &str) -> PathBuf {
    [env!("CARGO_MANIFEST_DIR"), "..", "fixtures", name]
        .iter()
        .collect()
}

fn expected() -> Value {
    let path = fixture("book.expected.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    serde_json::from_str(&raw).expect("book.expected.json is valid JSON")
}

fn s(v: &Value) -> &str {
    v.as_str()
        .unwrap_or_else(|| panic!("expected a string, got {v}"))
}

fn u(v: &Value) -> usize {
    v.as_u64()
        .unwrap_or_else(|| panic!("expected a number, got {v}")) as usize
}

/// Extracted text of a page with PDFium's `\r\n` line separators normalised to `\n`.
fn page_text(doc: &PdfDocument, index: usize) -> String {
    let page = doc.pages().get(index as i32).expect("page");
    let text = page.text().expect("text page");
    text.all().replace("\r\n", "\n")
}

fn codepoints(text: &str) -> String {
    text.chars()
        .map(|c| format!("U+{:04X}", c as u32))
        .collect::<Vec<_>>()
        .join(" ")
}

/// Whole-word occurrences of `word` (both neighbours must be non-alphanumeric).
fn count_whole_word(text: &str, word: &str) -> usize {
    let mut count = 0;
    let mut from = 0;
    while let Some(rel) = text[from..].find(word) {
        let start = from + rel;
        let end = start + word.len();
        let before_ok = text[..start]
            .chars()
            .next_back()
            .map_or(true, |c| !c.is_alphanumeric());
        let after_ok = text[end..]
            .chars()
            .next()
            .map_or(true, |c| !c.is_alphanumeric());
        if before_ok && after_ok {
            count += 1;
        }
        from = end;
    }
    count
}

// --- outline -------------------------------------------------------------------------------

#[derive(Debug)]
struct Entry {
    title: String,
    page: usize,
    children: Vec<Entry>,
}

fn read_level(first: Option<PdfBookmark<'_>>) -> Vec<Entry> {
    let mut out = Vec::new();
    let mut cursor = first;
    while let Some(bookmark) = cursor {
        let title = bookmark.title().unwrap_or_default();
        let page = bookmark
            .destination()
            .unwrap_or_else(|| panic!("bookmark {title:?} has no destination"))
            .page_index()
            .unwrap_or_else(|e| panic!("bookmark {title:?} destination page: {e:?}"))
            as usize;
        out.push(Entry {
            title,
            page,
            children: read_level(bookmark.first_child()),
        });
        cursor = bookmark.next_sibling();
    }
    out
}

fn check_outline(doc: &PdfDocument, expected: &Value) {
    let tree = read_level(doc.bookmarks().root());
    let want = expected["outline"].as_array().expect("outline array");
    assert_eq!(tree.len(), want.len(), "top-level outline entries");

    // Flat, document-order list of (depth, page) used to recompute `pageEnd` independently.
    let mut flat: Vec<(usize, usize)> = Vec::new();
    fn flatten(entries: &[Entry], depth: usize, out: &mut Vec<(usize, usize)>) {
        for e in entries {
            out.push((depth, e.page));
            flatten(&e.children, depth + 1, out);
        }
    }
    flatten(&tree, 0, &mut flat);
    let last_page = u(&expected["pageCount"]) - 1;

    let mut cursor = 0usize;
    fn compare(
        got: &[Entry],
        want: &[Value],
        depth: usize,
        flat: &[(usize, usize)],
        cursor: &mut usize,
        last_page: usize,
    ) {
        assert_eq!(got.len(), want.len(), "entries at depth {depth}");
        for (g, w) in got.iter().zip(want) {
            let idx = *cursor;
            *cursor += 1;
            assert_eq!(g.title, s(&w["title"]), "title");
            assert_eq!(g.page, u(&w["page"]), "page of {:?}", g.title);
            assert_eq!(depth, u(&w["depth"]), "depth of {:?}", g.title);
            assert_eq!(u(&w["pageLabel"]), g.page + 1, "pageLabel of {:?}", g.title);
            let page_end = flat[idx + 1..]
                .iter()
                .find(|(d, _)| *d <= depth)
                .map_or(last_page, |(_, p)| p - 1);
            assert_eq!(page_end, u(&w["pageEnd"]), "pageEnd of {:?}", g.title);
            compare(
                &g.children,
                w["children"].as_array().expect("children"),
                depth + 1,
                flat,
                cursor,
                last_page,
            );
        }
    }
    compare(&tree, want, 0, &flat, &mut cursor, last_page);
    assert_eq!(cursor, 18, "the outline has 18 entries in total");
}

// --- header / footer -----------------------------------------------------------------------

fn check_furniture(doc: &PdfDocument, texts: &[String], expected: &Value) {
    let count = u(&expected["pageCount"]);
    let first = u(&expected["header"]["firstPage"]);
    assert_eq!(first, u(&expected["footer"]["firstPage"]));
    let height = expected["pageSize"]["height"].as_f64().unwrap() as f32;
    let top_band = height * 0.92;
    let bottom_band = height * 0.08;

    for (index, text) in texts.iter().enumerate() {
        let header = expected["header"]["byPage"][index.to_string()].as_str();
        let footer = format!("Página {} de {count}", index + 1);
        if index < first {
            assert!(header.is_none(), "page {index} must have no header");
            assert!(!text.contains("Página"), "title page has no footer");
            continue;
        }
        let header = header.unwrap_or_else(|| panic!("header for page {index}"));
        let expected_header = if (index + 1) % 2 == 0 {
            s(&expected["header"]["even"]).to_string()
        } else {
            header.to_string()
        };
        assert_eq!(header, expected_header);
        assert!(
            text.lines().next().is_some_and(|l| l.trim() == header),
            "page {index}: first extracted line should be the header {header:?}, got {:?}",
            text.lines().next()
        );
        assert!(
            text.trim_end().ends_with(&footer),
            "page {index}: last extracted line should be {footer:?}"
        );

        // Position bands: header text sits in the top 8 %, footer in the bottom 8 %.
        let page = doc.pages().get(index as i32).unwrap();
        let ptext = page.text().unwrap();
        let mut header_ok = false;
        let mut footer_ok = false;
        for seg in ptext.segments().iter() {
            let t = seg.text();
            let b = seg.bounds();
            if t.trim() == header && b.bottom().value > top_band {
                header_ok = true;
            }
            if t.trim() == footer && b.top().value < bottom_band {
                footer_ok = true;
            }
        }
        assert!(header_ok, "page {index}: header not in the top band");
        assert!(footer_ok, "page {index}: footer not in the bottom band");
    }

    // Odd-page headers are grouped by chapter.
    for (title, pages) in expected["header"]["oddByChapter"].as_object().unwrap() {
        for p in pages.as_array().unwrap() {
            assert_eq!(s(&expected["header"]["byPage"][u(p).to_string()]), title);
        }
    }
}

// --- `contrato` counts ---------------------------------------------------------------------

fn check_contrato(texts: &[String], expected: &Value) {
    let by_page = expected["contrato"]["byPage"].as_object().unwrap();
    let in_headings = expected["contratoInTitles"]["headings"]["byPage"]
        .as_object()
        .unwrap();
    let in_headers = expected["contratoInTitles"]["headers"]["byPage"]
        .as_object()
        .unwrap();

    let mut total = 0;
    for (index, text) in texts.iter().enumerate() {
        let key = index.to_string();
        let get = |m: &serde_json::Map<String, Value>| m.get(&key).map_or(0, u);
        let found = count_whole_word(text, "contrato");
        let non_body = get(in_headings) + get(in_headers);
        assert_eq!(
            found - non_body.min(found),
            get(by_page),
            "page {index}: body `contrato` count (extracted {found}, headings/headers {non_body})"
        );
        assert!(found >= non_body, "page {index}: lost a title occurrence");
        total += found - non_body;
    }
    assert_eq!(total, u(&expected["contrato"]["total"]));
    assert!(total > 100, "more than 100 body occurrences");

    for forbidden in ["rescisão", "prazo", "indemnização"] {
        let pages: Vec<usize> = texts
            .iter()
            .enumerate()
            .filter(|(_, t)| count_whole_word(t, forbidden) > 0)
            .map(|(i, _)| i)
            .collect();
        let want: &[usize] = match forbidden {
            "rescisão" => &[16, 29, 33],
            "prazo" => &[16, 29],
            _ => &[16, 29, 37],
        };
        assert_eq!(pages, want, "pages containing {forbidden:?}");
    }

    let acao: Vec<usize> = texts
        .iter()
        .enumerate()
        .filter(|(_, t)| count_whole_word(t, "ação") > 0)
        .map(|(i, _)| i)
        .collect();
    let want: Vec<usize> = expected["acaoPages"]
        .as_array()
        .unwrap()
        .iter()
        .map(u)
        .collect();
    assert_eq!(acao, want, "pages with standalone ação");
    assert!(
        texts
            .iter()
            .all(|t| count_whole_word(&t.to_lowercase(), "acao") == 0),
        "unaccented `acao` must never appear"
    );
}

// --- controlled zones ----------------------------------------------------------------------

fn lines_of(v: &Value) -> Vec<&str> {
    v["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(s)
        .collect::<Vec<_>>()
}

fn char_span(text: &str, from: &str, to: &str) -> usize {
    let a = text.find(from).expect("first term");
    let b = text.find(to).expect("last term") + to.len();
    text[a..b].chars().count()
}

fn check_zones(doc: &PdfDocument, texts: &[String], expected: &Value) {
    for zone in ["tightTrio", "looseTrio"] {
        let z = &expected[zone];
        let text = &texts[u(&z["page"])];
        let lines = lines_of(z);
        for line in &lines {
            assert!(text.contains(line), "{zone}: line missing: {line:?}");
        }
        // Lines are consecutive on the page; joined with a single space they give the span the
        // generator designed (PDFium puts a line break where the generator put a space).
        let joined = lines.join("\n");
        assert!(text.contains(&joined), "{zone}: lines are not consecutive");
        let span = char_span(&joined, "rescisão", "indemnização");
        let designed = u(&z["spanChars"]);
        assert_eq!(span, designed, "{zone}: span with newline separators");
        assert!(text.contains("prazo"));
    }
    assert!(u(&expected["tightTrio"]["spanChars"]) > 100);
    assert!(u(&expected["tightTrio"]["spanChars"]) < 250);
    assert!(u(&expected["looseTrio"]["spanChars"]) > 250);
    assert!(u(&expected["looseTrio"]["spanChars"]) < 500);

    // Decoys: each term alone on its page, no `prazo` anywhere near.
    let d = &expected["decoy"];
    let resc = &texts[u(&d["rescisao"]["page"])];
    let inde = &texts[u(&d["indemnizacao"]["page"])];
    assert!(resc.contains("rescisão") && !resc.contains("indemnização") && !resc.contains("prazo"));
    assert!(inde.contains("indemnização") && !inde.contains("rescisão") && !inde.contains("prazo"));
    for line in lines_of(&d["rescisao"]).into_iter() {
        assert!(resc.contains(line));
    }
    for line in lines_of(&d["indemnizacao"]).into_iter() {
        assert!(inde.contains(line));
    }

    // Cross-page phrase: last body line of p.22 / first body line of p.23.
    let c = &expected["crossPage"];
    let from = &texts[u(&c["fromPage"])];
    let to = &texts[u(&c["toPage"])];
    let last_body = from
        .lines()
        .rev()
        .nth(1) // the footer is the last line
        .expect("last body line");
    assert_eq!(last_body.trim(), s(&c["lastLine"]));
    let first_body = to.lines().nth(1).expect("first body line"); // the header is line 0
    assert_eq!(first_body.trim(), s(&c["firstLine"]));
    assert!(last_body.trim_end().ends_with("fazer cessar"));
    assert!(first_body.starts_with("o acordo deve comunicá-lo"));

    // Hard hyphens and the soft hyphen, as seen by `text.all()` and by the per-char API.
    let mut hyphen_cases: Vec<(String, &Value, &str)> = Vec::new();
    for key in ["contrato", "preAviso"] {
        hyphen_cases.push((
            format!("hyphenated {key}"),
            &expected["hyphenated"][key],
            "-",
        ));
    }
    hyphen_cases.push((
        "softHyphen".to_string(),
        &expected["softHyphen"],
        "\u{00AD}",
    ));
    for (label, h, designed_end) in hyphen_cases {
        let line1 = s(&h["line1"]);
        let line2 = s(&h["line2"]);
        assert!(line1.ends_with(designed_end), "{label}: designed line end");
        let stem = line1.trim_end_matches(designed_end);
        let text = &texts[u(&h["page"])];

        // (a) text.all(): what sits between the stem and the first word of the next line?
        let at = text
            .find(stem)
            .unwrap_or_else(|| panic!("{label}: line start missing: {stem:?}"));
        let rest = &text[at + stem.len()..];
        let next_start: String = line2.chars().take(6).collect();
        let sep_len = rest.find(&next_start).unwrap_or_else(|| {
            panic!("{label}: next line start {next_start:?} not after the stem")
        });
        let sep = &rest[..sep_len];
        println!(
            "{label}: text.all() separator between line 1 and line 2 = [{}]",
            codepoints(sep)
        );
        assert!(
            sep.chars().count() <= 2,
            "{label}: unexpected separator {sep:?}"
        );

        // (b) per-char API: code point + generated/hyphen flags for the same junction.
        let page = doc.pages().get(u(&h["page"]) as i32).unwrap();
        let ptext = page.text().unwrap();
        let chars = ptext.chars();
        let cps: Vec<(char, bool, bool)> = chars
            .iter()
            .map(|c| {
                (
                    c.unicode_char().unwrap_or('\u{FFFD}'),
                    c.is_generated().unwrap_or(false),
                    c.is_hyphen().unwrap_or(false),
                )
            })
            .collect();
        let stream: Vec<char> = cps.iter().map(|c| c.0).collect();
        let stem_chars: Vec<char> = stem.chars().collect();
        let pos = stream
            .windows(stem_chars.len())
            .position(|w| w == stem_chars.as_slice())
            .unwrap_or_else(|| panic!("{label}: stem not in the char stream"));
        let junction: Vec<String> = cps[pos + stem_chars.len()..]
            .iter()
            .take(4)
            .map(|(ch, generated, hyphen)| {
                format!(
                    "U+{:04X}(generated={generated},hyphen={hyphen})",
                    *ch as u32
                )
            })
            .collect();
        println!("{label}: chars after the stem = {}", junction.join(" "));
    }

    // Ligatures: real glyphs (fi/fl) through a /Differences encoding.
    let l = &expected["ligatures"];
    let text = &texts[u(&l["page"])];
    let line = text
        .lines()
        .find(|ln| ln.contains("cácia do mecanismo"))
        .unwrap_or_else(|| panic!("ligature line not extracted; page text: {text:?}"));
    println!("ligatures: line = {line:?}");
    println!("ligatures: code points = {}", codepoints(line));
    let fi_word: String = line
        .split_whitespace()
        .find(|w| w.ends_with("cácia"))
        .unwrap()
        .to_string();
    let fl_word: String = line
        .split_whitespace()
        .find(|w| w.ends_with("uxo"))
        .unwrap()
        .to_string();
    println!(
        "ligatures: eficácia -> {fi_word:?} [{}], fluxo -> {fl_word:?} [{}]",
        codepoints(&fi_word),
        codepoints(&fl_word)
    );
    // Per-char view of the "fi" glyph: does PDFium give one char box or two?
    {
        let page = doc.pages().get(u(&l["page"]) as i32).unwrap();
        let ptext = page.text().unwrap();
        let ptext_chars = ptext.chars();
        let all: Vec<_> = ptext_chars.iter().collect();
        let stream: Vec<char> = all
            .iter()
            .map(|c| c.unicode_char().unwrap_or('\u{FFFD}'))
            .collect();
        let needle: Vec<char> = "cácia do mecanismo".chars().collect();
        let pos = stream
            .windows(needle.len())
            .position(|w| w == needle.as_slice())
            .expect("ligature word in the char stream");
        for c in &all[pos - 3..pos] {
            let b = c.loose_bounds().unwrap();
            println!(
                "ligatures: char U+{:04X} index {} x = [{:.2}, {:.2}]",
                c.unicode_value(),
                c.index(),
                b.left().value,
                b.right().value
            );
        }
    }
    // Tolerant: either the ligature code point or the expanded letters, but nothing else.
    assert!(
        ["e\u{FB01}cácia", "eficácia"].contains(&fi_word.as_str()),
        "unexpected extraction of the fi ligature: {fi_word:?}"
    );
    assert!(
        ["\u{FB02}uxo", "fluxo"].contains(&fl_word.as_str()),
        "unexpected extraction of the fl ligature: {fl_word:?}"
    );

    // Curly quotes + NBSP.
    let q = &expected["quotesNbsp"];
    let text = &texts[u(&q["page"])];
    let line = text
        .lines()
        .find(|ln| ln.contains("justa causa"))
        .expect("quotes line");
    println!("quotesNbsp: line = {line:?}");
    println!("quotesNbsp: code points of the quoted phrase and the art. 12.º phrase:");
    let a = line.find('\u{201C}').map(|i| &line[i..]).unwrap_or(line);
    println!("  {}", codepoints(a.split("causa").next().unwrap_or("")));
    let nb = line
        .find("art.")
        .map(|i| &line[i..i + 14.min(line.len() - i)]);
    println!("  {}", nb.map(codepoints).unwrap_or_default());
    assert!(
        line.contains('\u{201C}') && line.contains('\u{201D}'),
        "curly quotes survive extraction"
    );
    assert!(
        line.contains("art.\u{00A0}12.º") || line.contains("art. 12.º"),
        "NBSP extracted as U+00A0 or a plain space"
    );
}

#[test]
fn book_fixture_matches_expected_json() {
    let expected = expected();
    let pdfium = rubrica_lib::engine::pdfium::shared();

    let book = pdfium
        .load_pdf_from_file(&fixture("book.pdf"), None)
        .expect("open book.pdf");
    let count = u(&expected["pageCount"]);
    assert_eq!(count, 40);
    assert_eq!(book.pages().len() as usize, count);

    let texts: Vec<String> = (0..count).map(|i| page_text(&book, i)).collect();

    check_outline(&book, &expected);
    check_furniture(&book, &texts, &expected);
    check_contrato(&texts, &expected);
    check_zones(&book, &texts, &expected);

    let flat = pdfium
        .load_pdf_from_file(&fixture("book-no-outline.pdf"), None)
        .expect("open book-no-outline.pdf");
    assert_eq!(flat.pages().len() as usize, count);
    assert!(
        flat.bookmarks().root().is_none(),
        "book-no-outline.pdf must have no bookmarks"
    );
    assert_eq!(flat.bookmarks().iter().count(), 0);
    for (i, want) in texts.iter().enumerate() {
        assert!(
            &page_text(&flat, i) == want,
            "page {i} text differs without outline"
        );
    }
}
