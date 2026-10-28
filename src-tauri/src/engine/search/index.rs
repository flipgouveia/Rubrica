//! Per-page search index (S3). Built from a [`RawPage`] on the PDFium thread,
//! then cached in [`super::SearchCache`] and read from the search task.
//!
//! It holds the original text, a box per char, the line structure, and the
//! normalized text with a compact map back to original char indexes, so a
//! match found after removing accents/ligatures/hyphens still yields exact
//! rects. Budget: ≤ ~40 MB for 500 dense pages (see [`PageIndex::heap_bytes`]).
//!
//! # Layout (bytes per original char)
//!
//! | field    | type            | B/char | notes |
//! |----------|-----------------|--------|-------|
//! | `chars`  | `u16`           | 2      | BMP code unit; the rare astral char lives in the sorted `astral` side table |
//! | `boxes`  | `[u16; 4]`      | 8      | edges quantized on a per-page grid (≈ 0.01 pt on a Letter page), rounded outwards so the box never shrinks |
//! | `norm`   | `u16`           | 2      | the index fold ([`Fold::INDEX`]) as UTF-16 units |
//! | `map`    | `u32`           | 4      | normalized unit → original char index |
//!
//! 16 B/char: a 4000-char page is ~64 KB, 500 pages ~32 MB. Lines keep their
//! exact `f32` rects (a handful per page).
//!
//! FROZEN SIGNATURES (the pipeline and S5's tests rely on them): `from_raw`,
//! `page`, `char_count`, `has_text`, `line_texts`, `heap_bytes`. Add whatever
//! else the matcher needs.

use std::mem::size_of;
use std::ops::Range;

use super::normalize::{Fold, Folder};
use super::{BoxF, LineText, RawPage, TextLine};

/// Quantized box: `[x0, y0, x1, y1]`.
type QBox = [u16; 4];
/// Sentinel for "no box" (impossible for a real box: `x0 <= x1`).
const NO_BOX: QBox = [u16::MAX, u16::MAX, 0, 0];

/// Per-page quantization grid for char boxes.
#[derive(Debug, Clone, Copy)]
struct Grid {
    x0: f32,
    y0: f32,
    ux: f32,
    uy: f32,
}

impl Grid {
    fn fit(boxes: impl Iterator<Item = BoxF>) -> Grid {
        let (mut min_x, mut min_y) = (f32::INFINITY, f32::INFINITY);
        let (mut max_x, mut max_y) = (f32::NEG_INFINITY, f32::NEG_INFINITY);
        for b in boxes {
            min_x = min_x.min(b.x);
            min_y = min_y.min(b.y);
            max_x = max_x.max(b.right());
            max_y = max_y.max(b.top());
        }
        if !min_x.is_finite() || !min_y.is_finite() || !max_x.is_finite() || !max_y.is_finite() {
            return Grid {
                x0: 0.0,
                y0: 0.0,
                ux: 1.0,
                uy: 1.0,
            };
        }
        Grid {
            x0: min_x,
            y0: min_y,
            ux: ((max_x - min_x) / 65535.0).max(1e-4),
            uy: ((max_y - min_y) / 65535.0).max(1e-4),
        }
    }

    fn quantize(&self, b: BoxF) -> QBox {
        let q = |v: f32, o: f32, u: f32, up: bool| -> u16 {
            let t = (v - o) / u;
            (if up { t.ceil() } else { t.floor() }).clamp(0.0, 65535.0) as u16
        };
        let x0 = q(b.x, self.x0, self.ux, false);
        let y0 = q(b.y, self.y0, self.uy, false);
        [
            x0,
            y0,
            q(b.right(), self.x0, self.ux, true).max(x0),
            q(b.top(), self.y0, self.uy, true).max(y0),
        ]
    }

    fn dequantize(&self, q: QBox) -> BoxF {
        let x = self.x0 + q[0] as f32 * self.ux;
        let y = self.y0 + q[1] as f32 * self.uy;
        BoxF {
            x,
            y,
            w: (q[2] - q[0]) as f32 * self.ux,
            h: (q[3] - q[1]) as f32 * self.uy,
        }
    }
}

fn usable(b: &BoxF) -> bool {
    b.x.is_finite() && b.y.is_finite() && b.w.is_finite() && b.h.is_finite()
}

#[derive(Debug)]
pub struct PageIndex {
    page: u32,
    width: f32,
    height: f32,
    has_text: bool,
    /// Original chars, BMP only; an astral char is `U+FFFD` here and listed in `astral`.
    chars: Vec<u16>,
    astral: Vec<(u32, char)>,
    grid: Grid,
    boxes: Vec<QBox>,
    lines: Vec<TextLine>,
    /// Index fold of the page (UTF-16 units, may contain `normalize::HY`).
    norm: Vec<u16>,
    /// `norm[i]` came from original char `map[i]`.
    map: Vec<u32>,
    /// Original indexes of plain `-` chars promoted to line-end hyphens
    /// (sorted). U+0002 chars are always line-end hyphens and are not listed.
    hy_plain: Vec<u32>,
}

impl Default for PageIndex {
    fn default() -> Self {
        PageIndex::from_raw(&RawPage {
            page: 0,
            width: 0.0,
            height: 0.0,
            chars: Vec::new(),
            lines: Vec::new(),
        })
    }
}

fn is_break(c: char) -> bool {
    c == '\r' || c == '\n'
}

impl PageIndex {
    pub fn from_raw(raw: &RawPage) -> PageIndex {
        let n = raw.chars.len();

        let mut chars = Vec::with_capacity(n);
        let mut astral = Vec::new();
        for (i, c) in raw.chars.iter().enumerate() {
            match u16::try_from(c.ch as u32) {
                Ok(u) => chars.push(u),
                Err(_) => {
                    chars.push(0xFFFD);
                    astral.push((i as u32, c.ch));
                }
            }
        }

        let grid = Grid::fit(raw.chars.iter().filter_map(|c| c.bbox).filter(usable));
        let boxes: Vec<QBox> = raw
            .chars
            .iter()
            .map(|c| match c.bbox.filter(usable) {
                Some(b) => grid.quantize(b),
                None => NO_BOX,
            })
            .collect();

        let hy_plain = promoted_hyphens(raw);
        let is_hy =
            |i: usize| raw.chars[i].ch == '\u{2}' || hy_plain.binary_search(&(i as u32)).is_ok();

        let mut norm = Vec::with_capacity(n);
        let mut map = Vec::with_capacity(n);
        let mut folder = Folder::new(Fold::INDEX);
        for (i, c) in raw.chars.iter().enumerate() {
            folder.feed(i as u32, c.ch, is_hy(i), &mut |unit, orig| {
                norm.push(unit);
                map.push(orig);
            });
        }
        norm.shrink_to_fit();
        map.shrink_to_fit();

        PageIndex {
            page: raw.page,
            width: raw.width,
            height: raw.height,
            has_text: raw.has_text(),
            chars,
            astral,
            grid,
            boxes,
            lines: raw.lines.clone(),
            norm,
            map,
            hy_plain,
        }
    }

    pub fn page(&self) -> u32 {
        self.page
    }

    pub fn width(&self) -> f32 {
        self.width
    }

    pub fn height(&self) -> f32 {
        self.height
    }

    /// Number of chars in `text_page_layout`'s `char_index` space.
    pub fn char_count(&self) -> u32 {
        self.chars.len() as u32
    }

    /// Any non-blank extractable char (drives `SearchBatch.textless`).
    pub fn has_text(&self) -> bool {
        self.has_text
    }

    /// Must equal `RawPage::line_texts()` for the same page.
    pub fn line_texts(&self) -> Vec<LineText> {
        self.lines
            .iter()
            .map(|line| LineText {
                text: (line.chars.start..line.chars.end)
                    .map(|i| self.ch(i))
                    .collect(),
                chars: line.chars.clone(),
                rect: line.rect,
            })
            .collect()
    }

    /// Approximate heap bytes held by this index (capacity-based).
    pub fn heap_bytes(&self) -> usize {
        size_of::<PageIndex>()
            + self.chars.capacity() * size_of::<u16>()
            + self.astral.capacity() * size_of::<(u32, char)>()
            + self.boxes.capacity() * size_of::<QBox>()
            + self.lines.capacity() * size_of::<TextLine>()
            + self.norm.capacity() * size_of::<u16>()
            + self.map.capacity() * size_of::<u32>()
            + self.hy_plain.capacity() * size_of::<u32>()
    }

    // --- accessors for the matcher ---------------------------------------------------------

    /// The original char at `i` (`i < char_count()`).
    pub fn ch(&self, i: u32) -> char {
        let u = self.chars[i as usize];
        if u == 0xFFFD && !self.astral.is_empty() {
            if let Ok(pos) = self.astral.binary_search_by_key(&i, |(idx, _)| *idx) {
                return self.astral[pos].1;
            }
        }
        char::from_u32(u as u32).unwrap_or('\u{FFFD}')
    }

    /// The (dequantized) box of original char `i`, if it has one.
    pub fn box_of(&self, i: u32) -> Option<BoxF> {
        let q = self.boxes[i as usize];
        (q != NO_BOX).then(|| self.grid.dequantize(q))
    }

    /// Normalized text (index fold, UTF-16 units, may contain `normalize::HY`).
    pub fn norm(&self) -> &[u16] {
        &self.norm
    }

    /// `map()[k]` = original char index of `norm()[k]`.
    pub fn map(&self) -> &[u32] {
        &self.map
    }

    /// Is original char `i` a line-end hyphen (U+0002 or a promoted `-`)?
    pub fn is_hy(&self, i: u32) -> bool {
        self.chars[i as usize] == 2 || self.hy_plain.binary_search(&i).is_ok()
    }

    pub fn lines(&self) -> &[TextLine] {
        &self.lines
    }

    /// Index into [`lines`](Self::lines) of the line that contains char `i`.
    pub fn line_of(&self, i: u32) -> Option<usize> {
        let after = self.lines.partition_point(|l| l.chars.start <= i);
        let k = after.checked_sub(1)?;
        (i < self.lines[k].chars.end).then_some(k)
    }

    /// The char range of a line.
    pub fn line_range(&self, line: usize) -> Range<u32> {
        self.lines[line].chars.clone()
    }
}

/// Plain `-` chars that end a line inside a word ("contra-⏎to"): the hyphen is
/// preceded by a letter or digit and followed (after the line break) by a
/// letter. Mid-line hyphens ("pré-aviso" on one line) never qualify.
fn promoted_hyphens(raw: &RawPage) -> Vec<u32> {
    let mut out = Vec::new();
    for (i, c) in raw.chars.iter().enumerate() {
        if c.ch != '-' {
            continue;
        }
        let prev_ok = i > 0 && raw.chars[i - 1].ch.is_alphanumeric();
        if !prev_ok {
            continue;
        }
        let mut j = i + 1;
        while j < raw.chars.len() && is_break(raw.chars[j].ch) {
            j += 1;
        }
        let Some(next) = raw.chars.get(j) else {
            continue;
        };
        let breaks_here = j > i + 1 || line_ends_at(&raw.lines, i as u32 + 1);
        if breaks_here && next.ch.is_alphabetic() {
            out.push(i as u32);
        }
    }
    out
}

fn line_ends_at(lines: &[TextLine], end: u32) -> bool {
    let k = lines.partition_point(|l| l.chars.end < end);
    lines.get(k).is_some_and(|l| l.chars.end == end)
}

/// Helpers shared by this module's and the matcher's unit tests.
#[cfg(test)]
pub mod test_support {
    use super::super::extract::group_lines;
    use super::super::{BoxF, RawChar, RawPage};

    /// A synthetic page: each char of `text` is a 5×10 pt box on a 6 pt pitch;
    /// `'\n'` starts a new line 14 pt lower and, like PDFium, is emitted as a
    /// generated `\r\n` pair with no box. Spaces are real chars with boxes.
    pub fn raw_page(page: u32, text: &str) -> RawPage {
        let mut chars = Vec::new();
        let (mut x, mut y) = (36.0f32, 700.0f32);
        for c in text.chars() {
            if c == '\n' {
                for b in ['\r', '\n'] {
                    chars.push(RawChar {
                        ch: b,
                        bbox: None,
                        generated: true,
                    });
                }
                x = 36.0;
                y -= 14.0;
                continue;
            }
            chars.push(RawChar {
                ch: c,
                bbox: Some(BoxF {
                    x,
                    y,
                    w: 5.0,
                    h: 10.0,
                }),
                generated: false,
            });
            x += 6.0;
        }
        let lines = group_lines(&chars);
        RawPage {
            page,
            width: 612.0,
            height: 792.0,
            chars,
            lines,
        }
    }

    pub fn index(page: u32, text: &str) -> std::sync::Arc<super::PageIndex> {
        std::sync::Arc::new(super::PageIndex::from_raw(&raw_page(page, text)))
    }
}

#[cfg(test)]
mod tests {
    use super::super::normalize::HY;
    use super::test_support::raw_page;
    use super::*;

    fn norm_string(idx: &PageIndex) -> String {
        idx.norm()
            .iter()
            .map(|&u| if u == HY { '~' } else { u as u8 as char })
            .collect()
    }

    #[test]
    fn counts_and_flags() {
        let idx = PageIndex::from_raw(&raw_page(7, "Olá mundo"));
        assert_eq!(idx.page(), 7);
        assert_eq!(idx.char_count(), 9);
        assert!(idx.has_text());
        assert_eq!(idx.width(), 612.0);
        let blank = PageIndex::from_raw(&raw_page(0, "  \n "));
        assert!(!blank.has_text());
        assert!(!PageIndex::default().has_text());
        assert_eq!(PageIndex::default().char_count(), 0);
    }

    #[test]
    fn line_texts_equal_the_raw_page() {
        for text in [
            "one two\nthree four\n\nfive",
            "contra\u{2}to e pré\u{2}\naviso",
            "ação — “aspas”\n  \nfim",
            "",
            "\n\n\n",
        ] {
            let raw = raw_page(3, text);
            let idx = PageIndex::from_raw(&raw);
            assert_eq!(idx.line_texts(), raw.line_texts(), "{text:?}");
        }
    }

    #[test]
    fn astral_chars_round_trip() {
        let raw = raw_page(0, "a😀b😀c");
        let idx = PageIndex::from_raw(&raw);
        let back: String = (0..idx.char_count()).map(|i| idx.ch(i)).collect();
        assert_eq!(back, "a😀b😀c");
        assert_eq!(idx.line_texts(), raw.line_texts());
    }

    #[test]
    fn normalized_text_and_map() {
        let raw = raw_page(0, "Ação  de\nFÉ");
        let idx = PageIndex::from_raw(&raw);
        assert_eq!(norm_string(&idx), "acao de fe");
        // 'A' is char 0; the 2 spaces + CRLF collapse to one ' ' mapped to the
        // first blank of the run; 'F' follows the \r\n.
        let map = idx.map();
        assert_eq!(map[0], 0);
        assert_eq!(map[4], 4, "the single space maps to the first blank");
        assert_eq!(idx.ch(map[map.len() - 1]), 'É');
        assert!(map.windows(2).all(|w| w[0] <= w[1]), "map is monotonic");
    }

    #[test]
    fn u0002_becomes_the_hyphen_marker() {
        let idx = PageIndex::from_raw(&raw_page(0, "contra\u{2}to"));
        assert_eq!(norm_string(&idx), "contra~to");
        assert!(idx.is_hy(6));
        assert!(!idx.is_hy(5));
        assert_eq!(idx.map()[6], 6);
    }

    #[test]
    fn plain_hyphen_at_line_end_is_promoted_and_mid_line_is_not() {
        let idx = PageIndex::from_raw(&raw_page(0, "no contra-\nto fim e pré-aviso aqui"));
        assert_eq!(norm_string(&idx), "no contra~to fim e pre-aviso aqui");
        assert!(idx.is_hy(9));
        let mid = (10..idx.char_count()).find(|&i| idx.ch(i) == '-').unwrap();
        assert!(!idx.is_hy(mid), "mid-line hyphen stays a hyphen");
    }

    #[test]
    fn hyphen_not_between_letters_is_not_promoted() {
        // dash after a space, hyphen before a digit-led line, trailing hyphen
        // at the very end of the page.
        for text in ["a -\nb", "x-\n9", "fim-"] {
            let idx = PageIndex::from_raw(&raw_page(0, text));
            let any = (0..idx.char_count()).any(|i| idx.is_hy(i));
            assert!(!any, "{text:?}");
        }
    }

    #[test]
    fn ligature_codepoints_expand_in_the_normalized_stream() {
        let idx = PageIndex::from_raw(&raw_page(0, "e\u{FB01}c\u{E1}cia \u{FB02}uxo"));
        assert_eq!(norm_string(&idx), "eficacia fluxo");
        let map = idx.map();
        assert_eq!(map[1], 1);
        assert_eq!(map[2], 1, "both letters of a ligature point at its char");
    }

    #[test]
    fn soft_hyphen_char_is_dropped_from_the_normalized_stream() {
        let idx = PageIndex::from_raw(&raw_page(0, "obriga\u{AD}ções"));
        assert_eq!(norm_string(&idx), "obrigacoes");
    }

    #[test]
    fn boxes_round_trip_within_a_hundredth_of_a_point() {
        let raw = raw_page(0, "hello world\nsecond line");
        let idx = PageIndex::from_raw(&raw);
        for (i, c) in raw.chars.iter().enumerate() {
            match (c.bbox, idx.box_of(i as u32)) {
                (None, None) => {}
                (Some(a), Some(b)) => {
                    assert!((a.x - b.x).abs() < 0.02, "x {a:?} {b:?}");
                    assert!((a.y - b.y).abs() < 0.02, "y");
                    assert!((a.right() - b.right()).abs() < 0.02, "right");
                    assert!((a.top() - b.top()).abs() < 0.02, "top");
                    assert!(
                        b.x <= a.x + 1e-4 && b.right() >= a.right() - 1e-4,
                        "outwards"
                    );
                }
                other => panic!("box presence differs: {other:?}"),
            }
        }
    }

    #[test]
    fn non_finite_boxes_are_dropped_not_propagated() {
        let mut raw = raw_page(0, "ab");
        raw.chars[0].bbox = Some(BoxF {
            x: f32::NAN,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        });
        let idx = PageIndex::from_raw(&raw);
        assert!(idx.box_of(0).is_none());
        assert!(idx.box_of(1).is_some());
    }

    #[test]
    fn line_lookup() {
        let idx = PageIndex::from_raw(&raw_page(0, "ab\ncd"));
        // chars: a b \r \n c d
        assert_eq!(idx.line_of(0), Some(0));
        assert_eq!(idx.line_of(1), Some(0));
        assert_eq!(idx.line_of(2), None, "the line break is in no line");
        assert_eq!(idx.line_of(4), Some(1));
        assert_eq!(idx.line_of(5), Some(1));
        assert_eq!(idx.line_range(1), 4..6);
    }

    #[test]
    fn heap_bytes_tracks_the_layout() {
        let text = "x".repeat(4000);
        let idx = PageIndex::from_raw(&raw_page(0, &text));
        let bytes = idx.heap_bytes();
        // 2 + 8 + 2 + 4 = 16 B/char plus a small constant.
        assert!(bytes >= 16 * 4000, "{bytes}");
        assert!(bytes < 17 * 4000 + 1024, "{bytes}");
    }
}
