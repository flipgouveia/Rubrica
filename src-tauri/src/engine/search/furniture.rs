//! Running header/footer detection (S5), `agents/SEARCH-ORCHESTRATION.md`
//! §2.1 "Excluir cabeçalhos e rodapés". Pure Rust over [`PageLines`].
//!
//! FROZEN SIGNATURES (the pipeline relies on them): `detect`,
//! `Furniture::{lines, excluded_ranges, page_furniture}`, `FurnitureLine`.
//!
//! # The rule
//!
//! **Candidates.** A line is a candidate when its rect intersects the top or
//! the bottom *band* of its page: the outer [`BAND_FRACTION`] (8 %) of the page
//! height. Side (top/bottom) is decided by the line's rect; a line touching
//! both (tiny pages) goes to the side its centre is nearer to. Everything else
//! is body text and is never looked at again.
//!
//! **Position.** A candidate's position is the distance from its vertical
//! *centre* to the page edge of its side (top edge for the top band, bottom
//! edge for the bottom band), in points. The centre is stable across texts
//! with and without ascenders/descenders (the rect comes from tight glyph
//! boxes), and measuring from the page edge makes pages of slightly different
//! heights agree. Positions join one *position cluster* while consecutive
//! sorted values are at most [`POSITION_GAP`] apart and the cluster spans at
//! most [`POSITION_SPAN`] points.
//!
//! **Key.** The line text trimmed, whitespace collapsed (control characters,
//! e.g. PDFium's U+0002 line-end hyphen, count as whitespace), case-folded,
//! every run of digits replaced by one `#`, and every token that is a valid
//! Roman numeral (`iv`, `xii`, with surrounding punctuation kept) replaced by
//! `#`. Lines without any letter or digit have no key and are never furniture.
//!
//! **Rule A, repeated text.** For one key, one side and one position cluster,
//! let *n* be the number of distinct pages that carry it. The occurrences are
//! furniture when *n* ≥ 3 and *n* ≥ 30 % of all pages of the document, or
//! when the same holds for the even pages alone or the odd pages alone (so a
//! running head that only appears on one parity qualifies). Top and bottom
//! bands are counted separately.
//!
//! **Rule B, running-head slots.** Chapter titles in odd heads each repeat on
//! only a few pages, below 30 % of the pages, so rule A alone misses them. A
//! *slot* is one side, one page parity and one position cluster. A slot is a
//! running-head slot when it holds a line on at least [`SLOT_FILL_PERCENT`] %
//! (60 %) of the pages of that parity (and on at least 3 pages), and at least
//! [`SLOT_REPEAT_PERCENT`] % (50 %) of its lines are on a key that occurs on 2
//! or more pages of the slot. In a running-head slot, the lines whose key
//! occurs on 2 or more pages are furniture; a line whose text is unique in the
//! slot is left alone (a one-off line is not provably a header, and hiding a
//! real hit is worse than showing a header hit).
//!
//! A page's first body line that merely sits high, or a repeated line in the
//! middle of the page, fails every test above: it is outside the band, or its
//! key does not repeat, or its slot is not filled.
//!
//! `detect` is a deterministic pure function of its input and costs
//! O(candidates · log candidates) after one pass over every line.

use std::collections::HashMap;
use std::ops::Range;

use super::{BoxF, PageLines};
use crate::types::PageFurniture;

/// Fraction of the page height that forms the top and the bottom band.
const BAND_FRACTION: f32 = 0.08;
/// A repeating key must be on at least this many pages.
const MIN_PAGES: usize = 3;
/// ... and on at least this percentage of the pages (of all, or of a parity).
const MIN_SHARE_PERCENT: usize = 30;
/// Largest distance (points) between consecutive positions of one cluster.
const POSITION_GAP: f32 = 3.0;
/// Largest total span (points) of one position cluster.
const POSITION_SPAN: f32 = 6.0;
/// Rule B: share of a parity's pages a slot must be filled on.
const SLOT_FILL_PERCENT: usize = 60;
/// Rule B: share of a slot's lines that must be on a repeating key.
const SLOT_REPEAT_PERCENT: usize = 50;

/// One excluded line on a page.
#[derive(Debug, Clone, PartialEq)]
pub struct FurnitureLine {
    pub chars: Range<u32>,
    pub rect: BoxF,
}

/// Detected headers/footers for a whole document, by page.
#[derive(Debug, Default)]
pub struct Furniture {
    by_page: HashMap<u32, Vec<FurnitureLine>>,
}

impl Furniture {
    pub fn lines(&self, page: u32) -> &[FurnitureLine] {
        self.by_page.get(&page).map(Vec::as_slice).unwrap_or(&[])
    }

    /// Char ranges to hand to `Matcher::push_page` as excluded.
    pub fn excluded_ranges(&self, page: u32) -> Vec<Range<u32>> {
        self.lines(page)
            .iter()
            .map(|line| line.chars.clone())
            .collect()
    }

    /// The `SearchBatch.furniture` entry for a page (`None` when it has none).
    pub fn page_furniture(&self, page: u32) -> Option<PageFurniture> {
        let lines = self.lines(page);
        (!lines.is_empty()).then(|| PageFurniture {
            page,
            rects: lines.iter().map(|line| line.rect.to_rect()).collect(),
        })
    }
}

/// A line in the top or bottom band of its page.
struct Candidate {
    page: u32,
    /// Index into the `pages` slice, and into that page's `lines`.
    page_idx: usize,
    line_idx: usize,
    /// 0 = top band, 1 = bottom band.
    side: u8,
    /// `page % 2`.
    parity: u8,
    /// Distance in points from the line centre to its side's page edge.
    offset: f32,
    key: u32,
}

/// Page counts the thresholds are measured against.
struct Totals {
    all: usize,
    by_parity: [usize; 2],
}

impl Totals {
    /// Rule A's share test: ≥ 3 pages and ≥ 30 % of `of` pages.
    fn share(n: usize, of: usize) -> bool {
        n >= MIN_PAGES && n * 100 >= MIN_SHARE_PERCENT * of
    }
}

/// Detects headers/footers from EVERY page of the document (repetition is a
/// whole-document property, independent of the search scope).
pub fn detect(pages: &[PageLines]) -> Furniture {
    let mut totals = Totals {
        all: pages.len(),
        by_parity: [0; 2],
    };
    for page in pages {
        totals.by_parity[(page.page % 2) as usize] += 1;
    }

    let mut keys: HashMap<String, u32> = HashMap::new();
    let mut candidates: Vec<Candidate> = Vec::new();
    for (page_idx, page) in pages.iter().enumerate() {
        collect_candidates(page, page_idx, &mut keys, &mut candidates);
    }

    let mut marked = vec![false; candidates.len()];
    rule_repeated_text(&candidates, &totals, &mut marked);
    rule_running_head_slots(&candidates, &totals, &mut marked);

    let mut furniture = Furniture::default();
    for (candidate, _) in candidates.iter().zip(&marked).filter(|(_, m)| **m) {
        let line = &pages[candidate.page_idx].lines[candidate.line_idx];
        furniture
            .by_page
            .entry(candidate.page)
            .or_default()
            .push(FurnitureLine {
                chars: line.chars.clone(),
                rect: line.rect,
            });
    }
    furniture
}

fn collect_candidates(
    page: &PageLines,
    page_idx: usize,
    keys: &mut HashMap<String, u32>,
    out: &mut Vec<Candidate>,
) {
    let height = page.height;
    if !(height.is_finite() && height > 0.0) {
        return;
    }
    let band = height * BAND_FRACTION;
    for (line_idx, line) in page.lines.iter().enumerate() {
        let r = line.rect;
        if ![r.x, r.y, r.w, r.h].iter().all(|v| v.is_finite()) {
            continue;
        }
        let in_top = r.top() > height - band;
        let in_bottom = r.y < band;
        let centre = r.y + r.h / 2.0;
        let side = match (in_top, in_bottom) {
            (false, false) => continue,
            (true, false) => 0,
            (false, true) => 1,
            (true, true) => u8::from(centre < height / 2.0),
        };
        let Some(key) = normalize_key(&line.text) else {
            continue;
        };
        let next = keys.len() as u32;
        let key = *keys.entry(key).or_insert(next);
        out.push(Candidate {
            page: page.page,
            page_idx,
            line_idx,
            side,
            parity: (page.page % 2) as u8,
            offset: if side == 0 { height - centre } else { centre },
            key,
        });
    }
}

/// Splits `order` (candidate indexes already sorted by `group`, then offset)
/// into runs of one group and one position cluster.
fn position_clusters(
    order: &[usize],
    candidates: &[Candidate],
    group: impl Fn(&Candidate) -> (u8, u32),
) -> Vec<Range<usize>> {
    let mut clusters = Vec::new();
    let mut start = 0;
    for i in 1..=order.len() {
        let split = i == order.len() || {
            let prev = &candidates[order[i - 1]];
            let cur = &candidates[order[i]];
            group(prev) != group(cur)
                || cur.offset - prev.offset > POSITION_GAP
                || cur.offset - candidates[order[start]].offset > POSITION_SPAN
        };
        if split {
            if start < i {
                clusters.push(start..i);
            }
            start = i;
        }
    }
    clusters
}

fn by_offset(a: &Candidate, b: &Candidate) -> std::cmp::Ordering {
    a.offset.total_cmp(&b.offset)
}

/// Distinct pages in a cluster: `(all, even, odd)`.
fn distinct_pages(members: &[usize], candidates: &[Candidate]) -> (usize, usize, usize) {
    let mut pages: Vec<u32> = members.iter().map(|&i| candidates[i].page).collect();
    pages.sort_unstable();
    pages.dedup();
    let odd = pages.iter().filter(|p| **p % 2 == 1).count();
    (pages.len(), pages.len() - odd, odd)
}

/// Rule A: one key, one side, one position cluster, repeated enough.
fn rule_repeated_text(candidates: &[Candidate], totals: &Totals, marked: &mut [bool]) {
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&a, &b| {
        let (a, b) = (&candidates[a], &candidates[b]);
        (a.side, a.key)
            .cmp(&(b.side, b.key))
            .then_with(|| by_offset(a, b))
    });
    for cluster in position_clusters(&order, candidates, |c| (c.side, c.key)) {
        let members = &order[cluster];
        let (all, even, odd) = distinct_pages(members, candidates);
        if Totals::share(all, totals.all)
            || Totals::share(even, totals.by_parity[0])
            || Totals::share(odd, totals.by_parity[1])
        {
            for &i in members {
                marked[i] = true;
            }
        }
    }
}

/// Rule B: running heads whose text changes (chapter titles).
fn rule_running_head_slots(candidates: &[Candidate], totals: &Totals, marked: &mut [bool]) {
    let mut order: Vec<usize> = (0..candidates.len()).collect();
    order.sort_by(|&a, &b| {
        let (a, b) = (&candidates[a], &candidates[b]);
        (a.side, a.parity)
            .cmp(&(b.side, b.parity))
            .then_with(|| by_offset(a, b))
    });
    for cluster in position_clusters(&order, candidates, |c| (c.side, u32::from(c.parity))) {
        let members = &order[cluster];
        let parity = candidates[members[0]].parity as usize;
        let (pages, _, _) = distinct_pages(members, candidates);
        if pages < MIN_PAGES || pages * 100 < SLOT_FILL_PERCENT * totals.by_parity[parity] {
            continue;
        }
        // Keys that occur on 2 or more distinct pages of the slot.
        let mut by_key: Vec<(u32, u32, usize)> = members
            .iter()
            .map(|&i| (candidates[i].key, candidates[i].page, i))
            .collect();
        by_key.sort_unstable();
        let mut repeating: Vec<usize> = Vec::new();
        let mut group_start = 0;
        for i in 1..=by_key.len() {
            if i == by_key.len() || by_key[i].0 != by_key[group_start].0 {
                let group = &by_key[group_start..i];
                let distinct = 1 + group.windows(2).filter(|w| w[0].1 != w[1].1).count();
                if distinct >= 2 {
                    repeating.extend(group.iter().map(|g| g.2));
                }
                group_start = i;
            }
        }
        if repeating.len() * 100 >= SLOT_REPEAT_PERCENT * members.len() {
            for i in repeating {
                marked[i] = true;
            }
        }
    }
}

/// The comparison key of a line (see the module docs), or `None` when the line
/// has no letter or digit.
fn normalize_key(text: &str) -> Option<String> {
    let mut key = String::with_capacity(text.len());
    let mut any = false;
    for token in text.split(|c: char| c.is_whitespace() || c.is_control()) {
        if token.is_empty() {
            continue;
        }
        let lower = token.to_lowercase();
        let Some(first) = lower.find(|c: char| c.is_alphanumeric()) else {
            continue;
        };
        let last = lower.rfind(|c: char| c.is_alphanumeric()).unwrap_or(first);
        let last_end = last + lower[last..].chars().next().map_or(0, char::len_utf8);
        any = true;
        if !key.is_empty() {
            key.push(' ');
        }
        key.push_str(&lower[..first]);
        let core = &lower[first..last_end];
        if is_roman_numeral(core) {
            key.push('#');
        } else {
            let mut in_digits = false;
            for c in core.chars() {
                if c.is_numeric() {
                    if !in_digits {
                        key.push('#');
                    }
                    in_digits = true;
                } else {
                    in_digits = false;
                    key.push(c);
                }
            }
        }
        key.push_str(&lower[last_end..]);
    }
    any.then_some(key)
}

/// Whether `token` (lowercase) is a canonical Roman numeral, 1..=3999
/// (`iv`, `xii`; not `civil`, `mid`, `iiii`).
fn is_roman_numeral(token: &str) -> bool {
    if token.is_empty() || token.len() > 15 {
        return false;
    }
    let mut values = Vec::with_capacity(token.len());
    for c in token.chars() {
        values.push(match c {
            'i' => 1,
            'v' => 5,
            'x' => 10,
            'l' => 50,
            'c' => 100,
            'd' => 500,
            'm' => 1000,
            _ => return false,
        });
    }
    let mut total: i32 = 0;
    for (i, v) in values.iter().enumerate() {
        match values.get(i + 1) {
            Some(next) if next > v => total -= v,
            _ => total += v,
        }
    }
    if !(1..4000).contains(&total) {
        return false;
    }
    // Canonical form check rejects non-numerals such as "civil" or "iiii".
    const TABLE: [(i32, &str); 13] = [
        (1000, "m"),
        (900, "cm"),
        (500, "d"),
        (400, "cd"),
        (100, "c"),
        (90, "xc"),
        (50, "l"),
        (40, "xl"),
        (10, "x"),
        (9, "ix"),
        (5, "v"),
        (4, "iv"),
        (1, "i"),
    ];
    let mut rest = total;
    let mut canonical = String::new();
    for (value, symbol) in TABLE {
        while rest >= value {
            canonical.push_str(symbol);
            rest -= value;
        }
    }
    canonical == token
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::search::LineText;

    const H: f32 = 792.0;

    fn line(text: &str, centre_y: f32, chars: Range<u32>) -> LineText {
        LineText {
            text: text.to_owned(),
            chars,
            rect: BoxF {
                x: 72.0,
                y: centre_y - 4.0,
                w: 100.0,
                h: 8.0,
            },
        }
    }

    /// Centre of a line `offset` points below the page top.
    fn from_top(height: f32, offset: f32) -> f32 {
        height - offset
    }

    /// A page with an optional header, an optional footer and 3 body lines.
    fn page(n: u32, height: f32, header: Option<&str>, footer: Option<&str>) -> PageLines {
        let mut lines = Vec::new();
        let mut at = 0u32;
        if let Some(text) = header {
            lines.push(line(
                text,
                from_top(height, 40.0),
                at..at + text.len() as u32,
            ));
            at += text.len() as u32 + 2;
        }
        for (i, y) in [650.0f32, 400.0, 120.0].into_iter().enumerate() {
            let text = format!("corpo da pagina {n} linha {i}");
            let end = at + text.len() as u32;
            lines.push(line(&text, y * height / H, at..end));
            at = end + 2;
        }
        if let Some(text) = footer {
            lines.push(line(text, 30.0, at..at + text.len() as u32));
        }
        PageLines {
            page: n,
            height,
            lines,
        }
    }

    fn excluded_texts(pages: &[PageLines], f: &Furniture) -> Vec<(u32, String)> {
        let mut out = Vec::new();
        for p in pages {
            for fl in f.lines(p.page) {
                let l = p.lines.iter().find(|l| l.chars == fl.chars).unwrap();
                out.push((p.page, l.text.clone()));
            }
        }
        out
    }

    #[test]
    fn keys_fold_case_digits_and_roman_numerals() {
        let k = |s: &str| normalize_key(s).unwrap();
        assert_eq!(k("  Página   9 de 40 "), "página # de #");
        assert_eq!(k("Página 10 de 40"), "página # de #");
        assert_eq!(k("PÁGINA iv"), "página #");
        assert_eq!(k("Página xii"), "página #");
        assert_eq!(k("Página XII"), "página #");
        // Punctuation-only tokens (decorative dashes) are dropped, so "- 3 -"
        // and "3" are the same running page number.
        assert_eq!(k("- iv -"), "#");
        assert_eq!(k("- 3 -"), k("12"));
        assert_eq!(k("(ix)"), "(#)");
        assert_eq!(k("Page 1 of 500"), k("Page 499 of 500"));
        assert_eq!(k("1.2 Definições"), "#.# definições");
        // Words that merely use roman letters stay words.
        assert_eq!(k("Civil mid iiii"), "civil mid iiii");
        // Control characters count as whitespace.
        assert_eq!(k("a\u{2}b"), "a b");
        assert_eq!(normalize_key("  "), None);
        assert_eq!(normalize_key("— • —"), None);
    }

    #[test]
    fn roman_numeral_validator() {
        for ok in ["i", "iv", "ix", "xii", "xl", "xcix", "mcmxciv", "mmxxvi"] {
            assert!(is_roman_numeral(ok), "{ok}");
        }
        for bad in ["", "iiii", "vx", "civil", "mid", "dim", "abc", "ic", "mmmm"] {
            assert!(!is_roman_numeral(bad), "{bad}");
        }
    }

    #[test]
    fn roman_numeral_footers_are_furniture() {
        let romans = [
            "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii",
        ];
        let pages: Vec<_> = romans
            .iter()
            .enumerate()
            .map(|(i, r)| page(i as u32, H, None, Some(&format!("Página {r}"))))
            .collect();
        let f = detect(&pages);
        for p in &pages {
            assert_eq!(f.lines(p.page).len(), 1, "page {}", p.page);
            assert!(excluded_texts(&pages, &f)
                .iter()
                .all(|(_, t)| t.starts_with("Página")));
        }
    }

    #[test]
    fn even_and_odd_heads_with_different_text() {
        // 40 pages like book.pdf: odd pages (0-based) carry "Manual", even
        // pages carry the chapter title (5 chapters of 4 pages): each title is
        // on 4 of 40 pages (10 %) and 4 of 20 even pages (20 %), below 30 %.
        let chapters = ["um", "dois", "tres", "quatro", "cinco"];
        let mut pages = Vec::new();
        for n in 0..40u32 {
            let head = if n == 0 {
                None
            } else if n % 2 == 1 {
                Some("Manual de Contratos".to_owned())
            } else {
                let chapter = (n as usize / 2 - 1) / 4;
                Some(format!("{} Capítulo {}", chapter + 1, chapters[chapter]))
            };
            pages.push(page(
                n,
                H,
                head.as_deref(),
                Some(&format!("Página {} de 40", n + 1)),
            ));
        }
        let f = detect(&pages);
        for p in &pages {
            let expected = if p.page == 0 { 1 } else { 2 };
            assert_eq!(f.lines(p.page).len(), expected, "page {}", p.page);
        }
        // No body line anywhere.
        assert!(excluded_texts(&pages, &f)
            .iter()
            .all(|(_, t)| !t.starts_with("corpo")));
    }

    #[test]
    fn two_pages_are_below_the_minimum() {
        let pages = vec![
            page(0, H, Some("Cabeçalho"), Some("Página 1")),
            page(1, H, Some("Cabeçalho"), Some("Página 2")),
        ];
        let f = detect(&pages);
        assert!(f.lines(0).is_empty() && f.lines(1).is_empty());
        // Three pages are enough.
        let pages = vec![
            page(0, H, Some("Cabeçalho"), Some("Página 1")),
            page(1, H, Some("Cabeçalho"), Some("Página 2")),
            page(2, H, Some("Cabeçalho"), Some("Página 3")),
        ];
        let f = detect(&pages);
        assert!((0..3).all(|p| f.lines(p).len() == 2));
    }

    #[test]
    fn repeated_line_at_mid_page_is_not_furniture() {
        let pages: Vec<_> = (0..10u32)
            .map(|n| {
                let mut p = page(n, H, None, None);
                p.lines.push(line("Linha repetida", 396.0, 900..914));
                p
            })
            .collect();
        let f = detect(&pages);
        assert!((0..10).all(|p| f.lines(p).is_empty()));
    }

    #[test]
    fn unique_high_body_lines_are_not_furniture() {
        // The first body line sits inside the top band and the position is
        // identical on every page, but the text never repeats.
        let pages: Vec<_> = (0..20u32)
            .map(|n| {
                let mut p = page(n, H, None, None);
                // Letters, not digits, so normalisation cannot merge them.
                let text = format!("Titulo {}", "x".repeat(n as usize + 2));
                p.lines.push(line(&text, from_top(H, 30.0), 900..915));
                p
            })
            .collect();
        let f = detect(&pages);
        assert!((0..20).all(|p| f.lines(p).is_empty()));
    }

    #[test]
    fn slightly_different_page_heights_still_match() {
        let heights = [792.0f32, 800.0, 792.0, 780.0, 796.0, 792.0];
        let pages: Vec<_> = heights
            .iter()
            .enumerate()
            .map(|(i, h)| page(i as u32, *h, Some("Relatório anual"), Some("Pág. 7")))
            .collect();
        let f = detect(&pages);
        for p in &pages {
            assert_eq!(f.lines(p.page).len(), 2, "page {}", p.page);
        }
    }

    #[test]
    fn footer_at_a_different_position_does_not_join() {
        // The same text, but on 4 pages at offset 30 and on 2 pages at offset
        // 55 (still in the band): only the group of 4 qualifies (4 of 12 > 30 %
        // is false for 4/12 = 33.3 % true; the pair of 2 never has 3 pages).
        let mut pages: Vec<_> = (0..12u32)
            .map(|n| page(n, H, None, if n < 4 { Some("Rodapé fixo") } else { None }))
            .collect();
        for p in pages.iter_mut().take(6).skip(4) {
            p.lines.push(line("Rodapé fixo", 55.0, 800..811));
        }
        let f = detect(&pages);
        for n in 0..4 {
            assert_eq!(f.lines(n).len(), 1, "page {n}");
        }
        for n in 4..12 {
            assert!(f.lines(n).is_empty(), "page {n}");
        }
    }

    #[test]
    fn position_tolerance_is_a_few_points() {
        // Footer centres wobble by ±1 point: still one cluster.
        let pages: Vec<_> = (0..6u32)
            .map(|n| {
                let mut p = page(n, H, None, None);
                p.lines
                    .push(line("Rodapé", 30.0 + (n % 3) as f32 - 1.0, 800..806));
                p
            })
            .collect();
        let f = detect(&pages);
        assert!((0..6).all(|n| f.lines(n).len() == 1));
    }

    #[test]
    fn thirty_percent_is_the_threshold() {
        // 3 of 10 pages (mixed parity so no parity rule applies): furniture.
        let build = |on: &[u32], total: u32| -> Vec<PageLines> {
            (0..total)
                .map(|n| page(n, H, None, on.contains(&n).then_some("Confidencial")))
                .collect()
        };
        let pages = build(&[0, 1, 2], 10);
        let f = detect(&pages);
        assert!((0..3).all(|n| f.lines(n).len() == 1));
        // 2 of 10: below the minimum of 3 pages.
        let pages = build(&[0, 1], 10);
        assert!(detect(&pages).lines(0).is_empty());
        // 3 of 11 = 27 %: below 30 %.
        let pages = build(&[0, 1, 2], 11);
        let f = detect(&pages);
        assert!((0..3).all(|n| f.lines(n).is_empty()));
        // 3 of 10 but spread on 5-9: still 30 %.
        let pages = build(&[5, 6, 8], 10);
        assert_eq!(detect(&pages).lines(5).len(), 1);
    }

    #[test]
    fn parity_counts_independently() {
        // 20 pages: "Par" on 5 even pages only (25 % of all, 50 % of even).
        let pages: Vec<_> = (0..20u32)
            .map(|n| {
                page(
                    n,
                    H,
                    (n % 2 == 0 && n >= 10).then_some("Cabeçalho par"),
                    None,
                )
            })
            .collect();
        let f = detect(&pages);
        for n in 0..20 {
            let expected = usize::from(n % 2 == 0 && n >= 10);
            assert_eq!(f.lines(n).len(), expected, "page {n}");
        }
    }

    #[test]
    fn top_and_bottom_are_counted_separately() {
        // "Confidencial" on 2 top and 2 bottom bands of 10 pages: 4 in total
        // would pass 30 %, but each side alone has fewer than 3 pages.
        let pages: Vec<_> = (0..10u32)
            .map(|n| {
                page(
                    n,
                    H,
                    (n < 2).then_some("Confidencial"),
                    (2..4).contains(&n).then_some("Confidencial"),
                )
            })
            .collect();
        let f = detect(&pages);
        assert!((0..10).all(|n| f.lines(n).is_empty()));
    }

    #[test]
    fn unique_titles_in_a_filled_slot_are_not_furniture() {
        // A slide deck: every page has a different title at the same spot.
        let pages: Vec<_> = (0..20u32)
            .map(|n| {
                let title = format!("Slide {}", "ab".repeat(n as usize + 1));
                page(n, H, Some(&title), None)
            })
            .collect();
        let f = detect(&pages);
        assert!((0..20).all(|n| f.lines(n).is_empty()));
    }

    #[test]
    fn a_lone_title_in_a_running_head_slot_is_left_alone() {
        // 30 pages: "Manual" on odd pages, chapter titles on even pages. Each
        // title is on 2 even pages (below 30 % of 15 even pages), except the
        // last, which is on one page only: it is unique in the slot, so it is
        // not excluded, while the repeating titles are (rule B).
        let titles = [
            "Alfa", "Alfa", "Beta", "Beta", "Gama", "Gama", "Delta", "Delta", "Eps", "Eps", "Zeta",
            "Zeta", "Eta", "Eta", "Teta",
        ];
        let pages: Vec<_> = (0..30u32)
            .map(|n| {
                let head = if n % 2 == 1 {
                    "Manual"
                } else {
                    titles[n as usize / 2]
                };
                page(n, H, Some(head), None)
            })
            .collect();
        let f = detect(&pages);
        for n in 0..28 {
            assert_eq!(f.lines(n).len(), 1, "page {n}");
        }
        assert!(f.lines(28).is_empty(), "the unique title");
        assert_eq!(f.lines(29).len(), 1);
    }

    #[test]
    fn empty_and_degenerate_input() {
        assert!(detect(&[]).lines(0).is_empty());
        let pages = vec![
            PageLines {
                page: 0,
                height: 0.0,
                lines: vec![line("x", 0.0, 0..1)],
            },
            PageLines {
                page: 1,
                height: f32::NAN,
                lines: vec![line("x", 0.0, 0..1)],
            },
            PageLines {
                page: 2,
                height: H,
                lines: vec![],
            },
        ];
        let f = detect(&pages);
        assert!((0..3).all(|n| f.lines(n).is_empty()));
    }

    #[test]
    fn accessors_return_what_detect_found() {
        let pages: Vec<_> = (0..5u32)
            .map(|n| page(n, H, Some("Cabeçalho"), Some(&format!("Página {}", n + 1))))
            .collect();
        let f = detect(&pages);
        for p in &pages {
            let lines = f.lines(p.page);
            assert_eq!(lines.len(), 2);
            let ranges = f.excluded_ranges(p.page);
            assert_eq!(ranges.len(), 2);
            assert_eq!(ranges[0], lines[0].chars);
            assert_eq!(ranges[1], lines[1].chars);
            let pf = f.page_furniture(p.page).expect("furniture");
            assert_eq!(pf.page, p.page);
            assert_eq!(pf.rects.len(), 2);
            assert_eq!(pf.rects[0].x, lines[0].rect.x as f64);
            assert_eq!(pf.rects[0].height, lines[0].rect.h as f64);
        }
        assert!(f.lines(99).is_empty());
        assert!(f.excluded_ranges(99).is_empty());
        assert!(f.page_furniture(99).is_none());
    }

    #[test]
    fn detect_is_deterministic() {
        let pages: Vec<_> = (0..30u32)
            .map(|n| {
                page(
                    n,
                    H,
                    Some(if n % 2 == 0 { "Par" } else { "Impar" }),
                    Some("Fim"),
                )
            })
            .collect();
        let a = detect(&pages);
        let b = detect(&pages);
        for n in 0..30 {
            assert_eq!(a.lines(n), b.lines(n));
        }
    }

    #[test]
    fn five_hundred_pages_are_fast() {
        let pages: Vec<_> = (0..500u32)
            .map(|n| {
                page(
                    n,
                    H,
                    Some("Cabeçalho"),
                    Some(&format!("Página {} de 500", n + 1)),
                )
            })
            .collect();
        let started = std::time::Instant::now();
        let f = detect(&pages);
        let elapsed = started.elapsed();
        assert!((0..500).all(|n| f.lines(n).len() == 2));
        // Debug builds are far slower than release; the budget is 50 ms in
        // release, so a generous bound here still catches an accidental
        // quadratic.
        assert!(elapsed.as_millis() < 500, "{elapsed:?}");
    }
}
