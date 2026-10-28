//! The one place search v2 reads PDFium: a page's chars and lines, in one
//! pass. Call it only on the PDFium owner thread (inside `with_session`).

use pdfium_render::prelude::*;

use super::{BoxF, LineText, PageLines, RawChar, RawPage, TextLine};

fn to_box(rect: PdfRect) -> BoxF {
    BoxF {
        x: rect.left().value,
        y: rect.bottom().value,
        w: rect.width().value,
        h: rect.height().value,
    }
}

fn is_break(ch: char) -> bool {
    ch == '\n' || ch == '\r'
}

/// Extracts `page`'s characters (same indexes as `text_page_layout`) and
/// groups them into visual lines. A page without a text layer yields no chars
/// and no lines, never an error.
pub fn extract_page(pdf_page: &PdfPage, page: u32) -> RawPage {
    let mut raw = RawPage {
        page,
        width: pdf_page.width().value,
        height: pdf_page.height().value,
        chars: Vec::new(),
        lines: Vec::new(),
    };
    let Ok(text) = pdf_page.text() else {
        return raw;
    };
    let chars = text.chars();
    raw.chars.reserve(chars.len());
    for index in 0..chars.len() {
        raw.chars.push(match chars.get(index) {
            Ok(c) => RawChar {
                ch: c.unicode_char().unwrap_or('\u{FFFD}'),
                bbox: c
                    .tight_bounds()
                    .or_else(|_| c.loose_bounds())
                    .ok()
                    .map(to_box),
                generated: c.is_generated().unwrap_or(false),
            },
            Err(_) => RawChar {
                ch: '\u{FFFD}',
                bbox: None,
                generated: true,
            },
        });
    }
    raw.lines = group_lines(&raw.chars);
    raw
}

/// Splits chars into lines: a line ends at a `\r`/`\n`, or when the next
/// boxed char sits entirely above or below the current line (text drawn
/// without PDFium inserting a break). Whitespace-only lines are dropped.
pub fn group_lines(chars: &[RawChar]) -> Vec<TextLine> {
    let mut lines = Vec::new();
    let mut start: Option<u32> = None;
    let mut rect: Option<BoxF> = None;

    let mut flush = |start: &mut Option<u32>, rect: &mut Option<BoxF>, end: u32| {
        if let (Some(s), Some(r)) = (start.take(), rect.take()) {
            lines.push(TextLine {
                chars: s..end,
                rect: r,
            });
        }
        *start = None;
    };

    for (i, c) in chars.iter().enumerate() {
        let i = i as u32;
        if is_break(c.ch) {
            flush(&mut start, &mut rect, i);
            continue;
        }
        if let (Some(b), Some(r)) = (c.bbox, rect) {
            let disjoint = b.y >= r.top() || b.top() <= r.y;
            if disjoint && !c.ch.is_whitespace() {
                flush(&mut start, &mut rect, i);
            }
        }
        if start.is_none() {
            start = Some(i);
        }
        if let Some(b) = c.bbox.filter(|_| !c.ch.is_whitespace()) {
            rect = Some(rect.map_or(b, |r| r.union(&b)));
        }
    }
    flush(&mut start, &mut rect, chars.len() as u32);
    lines
}

impl RawPage {
    /// The text of every line, for header/footer detection.
    pub fn line_texts(&self) -> Vec<LineText> {
        self.lines
            .iter()
            .map(|line| LineText {
                text: self.chars[line.chars.start as usize..line.chars.end as usize]
                    .iter()
                    .map(|c| c.ch)
                    .collect(),
                chars: line.chars.clone(),
                rect: line.rect,
            })
            .collect()
    }

    pub fn page_lines(&self) -> PageLines {
        PageLines {
            page: self.page,
            height: self.height,
            lines: self.line_texts(),
        }
    }

    pub fn has_text(&self) -> bool {
        self.chars
            .iter()
            .any(|c| !c.ch.is_whitespace() && !c.ch.is_control() && c.ch != '\u{FFFD}')
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(ch: char, x: f32, y: f32) -> RawChar {
        RawChar {
            ch,
            bbox: Some(BoxF {
                x,
                y,
                w: 5.0,
                h: 10.0,
            }),
            generated: false,
        }
    }

    fn brk(ch: char) -> RawChar {
        RawChar {
            ch,
            bbox: None,
            generated: true,
        }
    }

    #[test]
    fn splits_on_generated_breaks_and_excludes_them() {
        let chars = vec![
            ch('a', 0.0, 100.0),
            ch('b', 5.0, 100.0),
            brk('\r'),
            brk('\n'),
            ch('c', 0.0, 80.0),
        ];
        let lines = group_lines(&chars);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].chars, 0..2);
        assert_eq!(lines[1].chars, 4..5);
        assert_eq!(
            lines[0].rect,
            BoxF {
                x: 0.0,
                y: 100.0,
                w: 10.0,
                h: 10.0
            }
        );
    }

    #[test]
    fn splits_when_the_next_char_is_on_another_line_without_a_break() {
        let chars = vec![ch('a', 0.0, 100.0), ch('b', 0.0, 80.0)];
        let lines = group_lines(&chars);
        assert_eq!(lines.len(), 2);
    }

    #[test]
    fn line_texts_round_trip() {
        let raw = RawPage {
            page: 0,
            width: 100.0,
            height: 100.0,
            chars: vec![ch('h', 0.0, 50.0), ch('i', 5.0, 50.0)],
            lines: vec![],
        };
        let raw = RawPage {
            lines: group_lines(&raw.chars),
            ..raw
        };
        assert_eq!(raw.line_texts()[0].text, "hi");
        assert!(raw.has_text());
    }
}
