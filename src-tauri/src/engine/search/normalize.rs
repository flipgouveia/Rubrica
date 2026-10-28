//! Text normalization for search (S3): case folding, diacritics removal
//! ("ação" ↔ "acao"), ligatures (ﬁ → fi), curly quotes, NBSP, soft hyphens,
//! and the two-way handling of hard hyphens at line breaks
//! (`agents/SEARCH-ORCHESTRATION.md` §2.1 "Normalização"). Pure Rust; no
//! PDFium.
//!
//! # Model
//!
//! Text is folded into a stream of UTF-16 code units. Every unit remembers the
//! original char it came from (the caller's `orig` index), which is how the
//! matcher turns a hit in normalized text back into exact char boxes.
//!
//! * A page index always stores the **index fold** ([`Fold::INDEX`]: case
//!   folded, diacritics stripped). Queries that are stricter (case sensitive,
//!   or diacritics significant) scan that stream and then verify each
//!   candidate against the original chars refolded with the query's own
//!   [`Fold`], so a page is never re-normalized per query.
//! * Whitespace (every Unicode space, NBSP, `\r`, `\n`, tabs and other
//!   controls) collapses to one `' '`; leading whitespace is dropped and
//!   trailing whitespace is never emitted.
//! * Zero-width chars and the soft hyphen (U+00AD) are removed.
//! * A *line-end hyphen* becomes the marker unit [`HY`]. PDFium reports it as
//!   U+0002 (hard and soft hyphens alike); the index builder also promotes a
//!   plain `-` that ends a line. [`HY`] is optional for the matcher: a pattern
//!   without `-` skips it ("contrato" finds `contra\u{2}to`), a pattern with
//!   `-` consumes it ("pré-aviso" finds `pré\u{2}aviso`), and "préaviso" finds
//!   it too.

/// Marker unit for a line-end hyphen (PDFium's U+0002).
pub const HY: u16 = 0x0002;

/// Which distinctions a fold keeps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Fold {
    pub case_sensitive: bool,
    pub ignore_diacritics: bool,
}

impl Fold {
    /// What every cached page index is folded with.
    pub const INDEX: Fold = Fold {
        case_sensitive: false,
        ignore_diacritics: true,
    };

    /// `true` when this fold distinguishes more than [`Fold::INDEX`], so a
    /// candidate found in the index stream needs checking against the
    /// original text.
    pub fn needs_verification(self) -> bool {
        self.case_sensitive || !self.ignore_diacritics
    }
}

/// Whitespace-like: collapses into a single space. U+0002 is NOT blank (it is
/// the line-end hyphen marker).
pub fn is_blank(c: char) -> bool {
    c.is_whitespace() || (c.is_control() && c != '\u{2}')
}

/// Soft hyphen and zero-width chars: invisible, removed from every fold.
pub fn is_zero_width(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}' | '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
    )
}

/// Chars that vanish from the normalized text.
pub fn is_removed(c: char, fold: Fold) -> bool {
    is_zero_width(c) || (fold.ignore_diacritics && ('\u{0300}'..='\u{036F}').contains(&c))
}

/// Base letters for U+00C0..=U+017F (0 = no decomposition, keep the char).
#[rustfmt::skip]
const LATIN_BASE: [u8; 192] = *b"\
AAAAAA\0CEEEEIIII\
\0NOOOOO\0\0UUUUY\0\0\
aaaaaa\0ceeeeiiii\
\0nooooo\0\0uuuuy\0y\
AaAaAaCcCcCcCcDd\
\0\0EeEeEeEeEeGgGg\
GgGgHh\0\0IiIiIiIi\
I\0\0\0JjKk\0LlLlLl\0\
\0\0\0NnNnNn\0\0\0OoOo\
Oo\0\0RrRrRrSsSsSs\
SsTtTt\0\0UuUuUuUu\
UuUuWwYyYZzZzZzs";

/// Strips the diacritic from a Latin letter, keeping its case.
pub fn strip_diacritic(c: char) -> char {
    match c as u32 {
        0xC0..=0x17F => match LATIN_BASE[c as usize - 0xC0] {
            0 => c,
            base => base as char,
        },
        _ => c,
    }
}

/// Single-char lowercase; a multi-char lowercase (e.g. `İ`) is left alone so
/// folding never changes the char count.
fn lower(c: char) -> char {
    if c.is_ascii() {
        return c.to_ascii_lowercase();
    }
    let mut it = c.to_lowercase();
    match (it.next(), it.next()) {
        (Some(l), None) => l,
        _ => c,
    }
}

/// Maps one original char (not blank, not removed, not the hyphen marker)
/// to its folded form.
pub fn fold_char(c: char, fold: Fold, out: &mut impl FnMut(char)) {
    let mut put = |c: char| {
        let c = if fold.ignore_diacritics {
            strip_diacritic(c)
        } else {
            c
        };
        out(if fold.case_sensitive { c } else { lower(c) });
    };
    match c {
        // Ligatures (PDFium expands them already; some producers don't).
        '\u{FB00}' => "ff".chars().for_each(&mut put),
        '\u{FB01}' => "fi".chars().for_each(&mut put),
        '\u{FB02}' => "fl".chars().for_each(&mut put),
        '\u{FB03}' => "ffi".chars().for_each(&mut put),
        '\u{FB04}' => "ffl".chars().for_each(&mut put),
        '\u{FB05}' | '\u{FB06}' => "st".chars().for_each(&mut put),
        // Quotes and hyphens.
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' | '\u{2032}' => put('\''),
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' | '\u{2033}' => put('"'),
        '\u{2010}' | '\u{2011}' => put('-'),
        _ => put(c),
    }
}

fn push_utf16(c: char, sink: &mut impl FnMut(u16)) {
    let mut buf = [0u16; 2];
    for unit in c.encode_utf16(&mut buf) {
        sink(*unit);
    }
}

/// Incremental folder: feed original chars in order, get normalized units
/// tagged with the original index they came from.
#[derive(Debug)]
pub struct Folder {
    fold: Fold,
    started: bool,
    pending_ws: Option<u32>,
    skip_breaks: bool,
}

impl Folder {
    pub fn new(fold: Fold) -> Folder {
        Folder {
            fold,
            started: false,
            pending_ws: None,
            skip_breaks: false,
        }
    }

    /// Feeds one original char. `hy` marks it as a line-end hyphen (U+0002 or
    /// a promoted plain hyphen). `sink(unit, orig)` receives each output unit.
    pub fn feed(&mut self, orig: u32, c: char, hy: bool, sink: &mut impl FnMut(u16, u32)) {
        let mut c = c;
        if hy {
            if self.started && self.pending_ws.is_none() {
                sink(HY, orig);
                // A promoted plain hyphen is followed by the line break
                // itself: it is not a word separator.
                self.skip_breaks = true;
                return;
            }
            // A "hyphen" with nothing before it is just a dash.
            c = '-';
        }
        if self.skip_breaks && (c == '\r' || c == '\n') {
            return;
        }
        self.skip_breaks = false;
        if is_blank(c) {
            if self.started && self.pending_ws.is_none() {
                self.pending_ws = Some(orig);
            }
            return;
        }
        if is_removed(c, self.fold) {
            return;
        }
        if let Some(ws_orig) = self.pending_ws.take() {
            sink(b' ' as u16, ws_orig);
        }
        self.started = true;
        fold_char(c, self.fold, &mut |f| {
            push_utf16(f, &mut |unit| sink(unit, orig));
        });
    }
}

/// Folds a query string (or any free text) into units. U+0002 in the text is
/// read as a plain `-`.
pub fn fold_text(text: &str, fold: Fold) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    let mut folder = Folder::new(fold);
    for (i, c) in text.chars().enumerate() {
        let c = if c == '\u{2}' { '-' } else { c };
        folder.feed(i as u32, c, false, &mut |unit, _| out.push(unit));
    }
    out
}

/// `true` for a code unit that is a letter or digit (surrogates are not).
pub fn is_word_unit(unit: u16) -> bool {
    char::from_u32(unit as u32).is_some_and(|c| c.is_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn units(s: &str) -> String {
        String::from_utf16(&fold_text(s, Fold::INDEX)).unwrap()
    }

    fn strict(s: &str, case_sensitive: bool, ignore_diacritics: bool) -> String {
        String::from_utf16(&fold_text(
            s,
            Fold {
                case_sensitive,
                ignore_diacritics,
            },
        ))
        .unwrap()
    }

    #[test]
    fn portuguese_accents_fold_both_ways() {
        assert_eq!(units("ação"), "acao");
        assert_eq!(units("acao"), "acao");
        assert_eq!(units("Pré-aviso"), "pre-aviso");
        assert_eq!(units("ÃÕÇÁÀÂÉÊÍÓÔÚÜ"), "aocaaaeeioouu");
        assert_eq!(units("açúcar à vista, é só"), "acucar a vista, e so");
        assert_eq!(units("Água"), "agua");
    }

    #[test]
    fn full_latin1_and_latin_extended_a_tables_are_consistent() {
        // Every precomposed letter that has a base maps to an ASCII letter.
        for cp in 0xC0u32..=0x17F {
            let c = char::from_u32(cp).unwrap();
            let base = strip_diacritic(c);
            if base != c {
                assert!(base.is_ascii_alphabetic(), "U+{cp:04X} -> {base:?}");
            }
        }
        assert_eq!(strip_diacritic('Ñ'), 'N');
        assert_eq!(strip_diacritic('ñ'), 'n');
        assert_eq!(strip_diacritic('Ł'), 'Ł', "stroked letters are not accents");
        assert_eq!(strip_diacritic('ß'), 'ß');
        assert_eq!(strip_diacritic('Æ'), 'Æ');
        assert_eq!(strip_diacritic('ÿ'), 'y');
        assert_eq!(strip_diacritic('Ÿ'), 'Y');
        assert_eq!(strip_diacritic('ž'), 'z');
        assert_eq!(strip_diacritic('Ő'), 'O');
        assert_eq!(strip_diacritic('x'), 'x');
    }

    #[test]
    fn combining_marks_are_removed_only_when_ignoring_diacritics() {
        assert_eq!(units("a\u{301}cao"), "acao");
        assert_eq!(strict("a\u{301}", false, false), "a\u{301}");
    }

    #[test]
    fn case_folding_respects_the_flag() {
        assert_eq!(strict("Contrato", false, true), "contrato");
        assert_eq!(strict("Contrato", true, true), "Contrato");
        assert_eq!(
            strict("Ação", true, true),
            "Acao",
            "accent stripped, case kept"
        );
        assert_eq!(strict("Ação", true, false), "Ação");
        assert_eq!(strict("Ação", false, false), "ação");
    }

    #[test]
    fn ligatures_expand() {
        assert_eq!(units("e\u{FB01}c\u{E1}cia"), "eficacia");
        assert_eq!(units("\u{FB02}uxo"), "fluxo");
        assert_eq!(units("o\u{FB00}er \u{FB03}x \u{FB04}x"), "offer ffix fflx");
        assert_eq!(units("\u{FB05}\u{FB06}"), "stst");
    }

    #[test]
    fn curly_quotes_nbsp_and_soft_hyphen() {
        assert_eq!(units("\u{201C}justa causa\u{201D}"), "\"justa causa\"");
        assert_eq!(units("it\u{2019}s"), "it's");
        assert_eq!(units("art.\u{A0}12.º"), "art. 12.º");
        assert_eq!(units("obriga\u{AD}ções"), "obrigacoes");
        assert_eq!(units("a\u{200B}b"), "ab");
        assert_eq!(units("pre\u{2010}aviso"), "pre-aviso");
    }

    #[test]
    fn whitespace_runs_collapse_and_edges_trim() {
        assert_eq!(units("  a \t b\r\n\r\n c  "), "a b c");
        assert_eq!(units("\r\n"), "");
        assert_eq!(units("a\u{3000}b\u{2003}c"), "a b c");
    }

    #[test]
    fn line_end_hyphen_marker_in_the_stream() {
        let mut out = Vec::new();
        let mut f = Folder::new(Fold::INDEX);
        for (i, c) in "contra\u{2}to".chars().enumerate() {
            f.feed(i as u32, c, c == '\u{2}', &mut |u, o| out.push((u, o)));
        }
        let text: Vec<u16> = out.iter().map(|(u, _)| *u).collect();
        assert_eq!(text.len(), 9);
        assert_eq!(text[6], HY);
        assert_eq!(out[6].1, 6, "marker keeps the original index");
        assert_eq!(out[7].1, 7);
    }

    #[test]
    fn promoted_plain_hyphen_swallows_the_line_break_that_follows() {
        let mut out = Vec::new();
        let mut f = Folder::new(Fold::INDEX);
        for (i, c) in "contra-\r\nto".chars().enumerate() {
            f.feed(i as u32, c, c == '-', &mut |u, o| out.push((u, o)));
        }
        let text: Vec<u16> = out.iter().map(|(u, _)| *u).collect();
        assert_eq!(
            text,
            "contra"
                .encode_utf16()
                .chain([HY])
                .chain("to".encode_utf16())
                .collect::<Vec<_>>(),
            "no space between the halves"
        );
    }

    #[test]
    fn a_leading_hyphen_is_a_dash_not_a_marker() {
        assert_eq!(units("-5"), "-5");
        let mut out = Vec::new();
        let mut f = Folder::new(Fold::INDEX);
        f.feed(0, '\u{2}', true, &mut |u, _| out.push(u));
        assert_eq!(out, vec![b'-' as u16]);
    }

    #[test]
    fn query_u0002_reads_as_a_plain_hyphen() {
        assert_eq!(units("pre\u{2}aviso"), "pre-aviso");
    }

    #[test]
    fn astral_chars_become_surrogate_pairs() {
        let u = fold_text("a😀b", Fold::INDEX);
        assert_eq!(u.len(), 4);
        assert!(!is_word_unit(u[1]));
        assert!(is_word_unit(u[0]));
    }

    #[test]
    fn word_units() {
        assert!(is_word_unit('é' as u16));
        assert!(is_word_unit('7' as u16));
        assert!(!is_word_unit(' ' as u16));
        assert!(!is_word_unit('-' as u16));
        assert!(!is_word_unit(HY));
    }

    #[test]
    fn needs_verification_only_for_stricter_folds() {
        assert!(!Fold::INDEX.needs_verification());
        assert!(Fold {
            case_sensitive: true,
            ignore_diacritics: true
        }
        .needs_verification());
        assert!(Fold {
            case_sensitive: false,
            ignore_diacritics: false
        }
        .needs_verification());
    }

    #[test]
    fn turkish_dotted_i_does_not_change_length() {
        assert_eq!(units("İ").chars().count(), 1);
    }
}
