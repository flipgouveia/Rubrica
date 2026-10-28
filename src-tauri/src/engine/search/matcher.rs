//! Phrase / proximity matching over [`PageIndex`]es (S3). Pure Rust, runs on
//! the search task, never on the PDFium thread.
//!
//! FROZEN SIGNATURES (the pipeline in `commands/text.rs` calls exactly these):
//! `compile`, `CompiledQuery::{mode, term_count}`, `Matcher::{new, push_page,
//! finish}`, `FoundHit`, `rank`. Hits leave here with `outline_item_id: None`
//! (the pipeline fills it from `scope::deepest_item_for_page`).
//!
//! # How matching works
//!
//! Every pushed page becomes a transient *work stream*: the page's cached
//! normalized units with the `excluded` char ranges (headers/footers) cut out
//! and whitespace re-collapsed. Cutting them out is what makes a phrase join
//! across a removed footer/header and what makes them count 0 toward a window.
//! The work stream of page k+1 follows page k's in one global coordinate space
//! (a single space between them, none after a line-end hyphen), and only the
//! last two pages are ever alive, so a hit can continue from k onto k+1 and
//! never further.
//!
//! * **Scanning**: each term is searched in the stream with a first-unit scan
//!   plus a hyphen-aware comparison ([`match_from`]): the line-end hyphen
//!   marker is optional for a pattern without `-` and consumed by a `-`. Case /
//!   diacritic sensitive queries re-check each candidate against the original
//!   chars, refolded with the query's own fold. Cost: O(text) per term per page
//!   (the tail of the previous page is rescanned for terms that straddle the
//!   break); pages are never re-normalized per query.
//! * **Phrase mode**: every non-overlapping occurrence is a hit.
//! * **Proximity mode**: for each term occurrence taken as the window's first
//!   char, the tightest window takes, for every other term, its first
//!   occurrence at or after that start (monotone pointers: O(occurrences × terms)).
//!   Windows longer than N or containing an excluded term are dropped; a window
//!   with a smaller one nested inside is not minimal and is dropped; of two
//!   overlapping minimal windows the shorter wins (tie: the earlier).
//!   Window length = normalized chars from the first char of the first term to
//!   the last char of the last term, a whitespace run counting 1 and the
//!   line-end hyphen marker counting 0.

use std::ops::Range;
use std::sync::Arc;

use super::index::PageIndex;
use super::normalize::{self, is_word_unit, Fold, Folder, HY};
use super::BoxF;
use crate::types::{
    CmdResult, ContextTerm, HitRect, PageRect, RubricaError, SearchContext, SearchHit, SearchMode,
    SearchQuery,
};

const SPACE: u16 = b' ' as u16;
const DASH: u16 = b'-' as u16;
/// A work-stream unit that stands for no original char (an inserted space).
const SYNTH: u32 = u32::MAX;
/// `before` / `after` context width, in chars.
const CONTEXT_CHARS: usize = 60;
/// Original chars looked at for context (collapsing/exclusion eat some).
const CONTEXT_LOOKAROUND: u32 = 400;
/// `matched` longer than this is elided in the middle.
const MATCHED_MAX: usize = 160;
const ELIDE_KEEP: usize = 78;
const WINDOW_MIN: u32 = 20;
const WINDOW_MAX: u32 = 5000;
const MAX_TERMS: usize = 255;

// ---------------------------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------------------------

/// One term or phrase, normalized.
#[derive(Debug, Clone, PartialEq)]
struct Pattern {
    /// Index fold: what is searched in the cached page streams.
    full: Vec<u16>,
    /// The query's own fold, only when it is stricter than the index fold.
    strict: Option<Vec<u16>>,
}

impl Pattern {
    fn new(text: &str, fold: Fold) -> Option<Pattern> {
        let full = normalize::fold_text(text, Fold::INDEX);
        if full.is_empty() {
            return None;
        }
        let strict = fold
            .needs_verification()
            .then(|| normalize::fold_text(text, fold));
        Some(Pattern { full, strict })
    }
}

/// A parsed, normalized query.
#[derive(Debug, Clone)]
pub struct CompiledQuery {
    mode: SearchMode,
    fold: Fold,
    whole_word: bool,
    window: u32,
    /// Positive terms, identical ones merged (phrase mode: exactly one).
    terms: Vec<Pattern>,
    /// Proximity `-terms`.
    excluded: Vec<Pattern>,
}

impl CompiledQuery {
    pub fn mode(&self) -> SearchMode {
        self.mode
    }

    /// Positive terms (phrase mode: 1). Excluded `-terms` do not count, and a
    /// term typed twice counts once.
    pub fn term_count(&self) -> usize {
        self.terms.len()
    }
}

fn is_quote(c: char) -> bool {
    matches!(c, '"' | '\u{201C}' | '\u{201D}' | '\u{201E}')
}

/// Splits proximity text into `(is_exclusion, text)` tokens: spaces separate
/// terms, `"…"` is one exact-phrase term, a leading `-` excludes.
fn tokenize(text: &str) -> Vec<(bool, String)> {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut out = Vec::new();
    let mut i = 0;
    while i < n {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let mut exclude = false;
        if chars[i] == '-' && i + 1 < n && !chars[i + 1].is_whitespace() {
            exclude = true;
            i += 1;
        }
        if is_quote(chars[i]) {
            i += 1;
            let start = i;
            while i < n && !is_quote(chars[i]) {
                i += 1;
            }
            out.push((exclude, chars[start..i].iter().collect()));
            if i < n {
                i += 1;
            }
        } else {
            let start = i;
            while i < n && !chars[i].is_whitespace() {
                i += 1;
            }
            out.push((exclude, chars[start..i].iter().collect()));
        }
    }
    out
}

/// `INVALID_ARG` for an empty query, a proximity query without positive
/// terms, or a proximity window outside 20–5000.
pub fn compile(query: &SearchQuery) -> CmdResult<CompiledQuery> {
    if query.text.trim().is_empty() {
        return Err(RubricaError::invalid_arg("empty search query"));
    }
    let fold = Fold {
        case_sensitive: query.case_sensitive,
        ignore_diacritics: query.ignore_diacritics,
    };
    let mut compiled = CompiledQuery {
        mode: query.mode,
        fold,
        whole_word: query.whole_word,
        window: 0,
        terms: Vec::new(),
        excluded: Vec::new(),
    };
    match query.mode {
        SearchMode::Phrase => {
            let Some(pattern) = Pattern::new(&query.text, fold) else {
                return Err(RubricaError::invalid_arg("the search text is empty"));
            };
            compiled.terms.push(pattern);
        }
        SearchMode::Proximity => {
            let window = query
                .proximity
                .as_ref()
                .map(|p| p.window)
                .ok_or_else(|| RubricaError::invalid_arg("proximity search needs a window"))?;
            if !(WINDOW_MIN..=WINDOW_MAX).contains(&window) {
                return Err(RubricaError::invalid_arg(format!(
                    "proximity window must be {WINDOW_MIN}-{WINDOW_MAX} characters, got {window}"
                )));
            }
            compiled.window = window;
            for (exclude, text) in tokenize(&query.text) {
                let Some(pattern) = Pattern::new(&text, fold) else {
                    continue;
                };
                let list = if exclude {
                    &mut compiled.excluded
                } else {
                    &mut compiled.terms
                };
                if !list.contains(&pattern) {
                    list.push(pattern);
                }
            }
            if compiled.terms.is_empty() {
                return Err(RubricaError::invalid_arg(
                    "a proximity search needs at least one positive term",
                ));
            }
            if compiled.terms.len() > MAX_TERMS {
                return Err(RubricaError::invalid_arg("too many search terms"));
            }
        }
    }
    Ok(compiled)
}

// ---------------------------------------------------------------------------------------------
// Pattern comparison
// ---------------------------------------------------------------------------------------------

/// Compares `p` against `t` starting at `ti`; a line-end hyphen marker in `t`
/// is skipped, or consumed by a `-` in `p`. Returns the end (exclusive) in `t`.
fn match_from(t: &[u16], mut ti: usize, p: &[u16], mut pi: usize) -> Option<usize> {
    while pi < p.len() {
        let u = *t.get(ti)?;
        if u == HY {
            if p[pi] == DASH {
                if let Some(end) = match_from(t, ti + 1, p, pi + 1) {
                    return Some(end);
                }
            }
            ti += 1;
            continue;
        }
        if u != p[pi] {
            return None;
        }
        ti += 1;
        pi += 1;
    }
    Some(ti)
}

fn matches_whole(t: &[u16], p: &[u16]) -> bool {
    match_from(t, 0, p, 0) == Some(t.len())
}

fn word_before(t: &[u16], j: usize) -> bool {
    j > 0 && (t[j - 1] == HY || is_word_unit(t[j - 1]))
}

fn word_after(t: &[u16], e: usize) -> bool {
    e < t.len() && (t[e] == HY || is_word_unit(t[e]))
}

fn find_first(t: &[u16], from: usize, first: u16) -> Option<usize> {
    if first == DASH {
        t[from..]
            .iter()
            .position(|&u| u == DASH || u == HY)
            .map(|k| k + from)
    } else {
        t[from..].iter().position(|&u| u == first).map(|k| k + from)
    }
}

// ---------------------------------------------------------------------------------------------
// Work streams
// ---------------------------------------------------------------------------------------------

/// One pushed page, ready for matching.
struct PageWork {
    index: Arc<PageIndex>,
    /// Sorted, merged, non-empty ranges.
    excluded: Vec<Range<u32>>,
    units: Vec<u16>,
    /// Original char of each unit ([`SYNTH`] for an inserted space).
    map: Vec<u32>,
    /// `lpos[i]` = non-hyphen-marker units before unit `i` (length `n + 1`).
    lpos: Vec<u32>,
    /// Global coordinate of `units[0]`.
    base: u64,
    /// Global length coordinate of `units[0]`.
    lbase: u64,
}

fn merge_ranges(ranges: &[Range<u32>]) -> Vec<Range<u32>> {
    let mut v: Vec<Range<u32>> = ranges.iter().filter(|r| r.start < r.end).cloned().collect();
    v.sort_by_key(|r| r.start);
    let mut out: Vec<Range<u32>> = Vec::with_capacity(v.len());
    for r in v {
        match out.last_mut() {
            Some(last) if r.start <= last.end => last.end = last.end.max(r.end),
            _ => out.push(r),
        }
    }
    out
}

impl PageWork {
    fn build(index: Arc<PageIndex>, excluded: &[Range<u32>]) -> PageWork {
        let ex = merge_ranges(excluded);
        let (units, map) = if ex.is_empty() {
            (index.norm().to_vec(), index.map().to_vec())
        } else {
            let norm = index.norm();
            let omap = index.map();
            let mut units = Vec::with_capacity(norm.len());
            let mut map = Vec::with_capacity(norm.len());
            let mut skipped = false;
            let mut r = 0;
            for (k, &unit) in norm.iter().enumerate() {
                let o = omap[k];
                while r < ex.len() && ex[r].end <= o {
                    r += 1;
                }
                if r < ex.len() && ex[r].start <= o {
                    skipped = true;
                    continue;
                }
                if unit == SPACE {
                    if units.last().map_or(true, |&u| u == SPACE) {
                        continue;
                    }
                    units.push(unit);
                    map.push(o);
                    skipped = false;
                    continue;
                }
                if skipped {
                    if let Some(&last) = units.last() {
                        if last != SPACE && last != HY {
                            units.push(SPACE);
                            map.push(SYNTH);
                        }
                    }
                    skipped = false;
                }
                units.push(unit);
                map.push(o);
            }
            if units.last() == Some(&SPACE) {
                units.pop();
                map.pop();
            }
            (units, map)
        };
        let mut lpos = Vec::with_capacity(units.len() + 1);
        let mut acc = 0u32;
        lpos.push(0);
        for &u in &units {
            acc += (u != HY) as u32;
            lpos.push(acc);
        }
        PageWork {
            index,
            excluded: ex,
            units,
            map,
            lpos,
            base: 0,
            lbase: 0,
        }
    }

    fn len(&self) -> u64 {
        self.units.len() as u64
    }

    fn ltotal(&self) -> u64 {
        *self.lpos.last().unwrap_or(&0) as u64
    }

    fn is_excluded(&self, o: u32) -> bool {
        let k = self.excluded.partition_point(|r| r.end <= o);
        self.excluded.get(k).is_some_and(|r| r.start <= o)
    }
}

/// The page a hit starts on and, possibly, the next one.
#[derive(Clone, Copy)]
struct Pages<'a> {
    a: &'a PageWork,
    b: Option<&'a PageWork>,
}

impl<'a> Pages<'a> {
    /// `(slot, page, local unit)` of global unit `g`; `None` for the space
    /// between the two pages.
    fn locate(&self, g: u64) -> Option<(usize, &'a PageWork, usize)> {
        let a = self.a;
        if g >= a.base && g < a.base + a.len() {
            return Some((0, a, (g - a.base) as usize));
        }
        let b = self.b?;
        (g >= b.base && g < b.base + b.len()).then(|| (1, b, (g - b.base) as usize))
    }

    fn lstart(&self, g: u64) -> u64 {
        let (_, w, l) = self.locate(g).expect("occurrence start unit");
        w.lbase + w.lpos[l] as u64
    }

    fn lend(&self, ge: u64) -> u64 {
        let (_, w, l) = self.locate(ge - 1).expect("occurrence end unit");
        w.lbase + w.lpos[l] as u64 + (w.units[l] != HY) as u64
    }
}

// ---------------------------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------------------------

/// A hit plus the page it starts on (= its `SearchMatch.page`).
#[derive(Debug, Clone)]
pub struct FoundHit {
    pub page: u32,
    pub hit: SearchHit,
}

/// A term occurrence in global coordinates.
#[derive(Debug, Clone, Copy)]
struct Occ {
    term: u8,
    gs: u64,
    ge: u64,
    ls: u64,
    le: u64,
}

/// A candidate window before its hit is built.
#[derive(Debug, Clone, Copy)]
struct Window {
    gs: u64,
    ge: u64,
    ls: u64,
    le: u64,
}

struct BuiltWindow {
    gs: u64,
    ge: u64,
    len: u64,
    hit: FoundHit,
}

/// Streams pages in ascending order. A hit may continue from one page onto
/// the NEXT one only, and only when that page was pushed right after it (the
/// pipeline never pushes pages outside the scope, so windows stay inside it).
pub struct Matcher {
    query: Arc<CompiledQuery>,
    prev: Option<PageWork>,
    next_base: u64,
    next_lbase: u64,
    /// Positive occurrences of the last two pages, sorted by start.
    pos: Vec<Occ>,
    /// Excluded-term occurrences of the last two pages.
    excl: Vec<Occ>,
    last_end: Vec<u64>,
    excl_last_end: Vec<u64>,
    /// The newest minimal-window candidate, waiting for the next window to
    /// prove it is not nested.
    held: Option<BuiltWindow>,
    /// The window kept by the overlap sweep, not yet final.
    sweep: Option<BuiltWindow>,
}

impl Matcher {
    pub fn new(query: Arc<CompiledQuery>) -> Matcher {
        let terms = query.terms.len();
        let excluded = query.excluded.len();
        Matcher {
            query,
            prev: None,
            next_base: 1,
            next_lbase: 1,
            pos: Vec::new(),
            excl: Vec::new(),
            last_end: vec![0; terms],
            excl_last_end: vec![0; excluded],
            held: None,
            sweep: None,
        }
    }

    /// Feeds the next page. `excluded` are char ranges of this page to treat
    /// as absent (headers/footers): no match may use them and, in proximity
    /// mode, they do not count toward the window length. Returns the hits
    /// that are complete so far (they may start on the previous page).
    pub fn push_page(&mut self, index: Arc<PageIndex>, excluded: &[Range<u32>]) -> Vec<FoundHit> {
        let mut out = Vec::new();
        let consecutive = self
            .prev
            .as_ref()
            .is_some_and(|p| p.index.page().checked_add(1) == Some(index.page()));
        if self.prev.is_some() && !consecutive {
            self.drain(&mut out);
        }
        let prev = self.prev.take();

        let mut cur = PageWork::build(index, excluded);
        let sep = prev.as_ref().is_some_and(|p| {
            !p.units.is_empty() && !cur.units.is_empty() && p.units.last() != Some(&HY)
        });
        match &prev {
            Some(p) => {
                cur.base = p.base + p.len() + sep as u64;
                cur.lbase = p.lbase + p.ltotal() + sep as u64;
            }
            None => {
                cur.base = self.next_base;
                cur.lbase = self.next_lbase;
            }
        }

        {
            let pages = match &prev {
                Some(p) => Pages {
                    a: p,
                    b: Some(&cur),
                },
                None => Pages { a: &cur, b: None },
            };
            let plen = prev.as_ref().map_or(0, |p| p.units.len());
            let joined;
            let comb: &[u16] = match &prev {
                Some(p) => {
                    let mut v = Vec::with_capacity(p.units.len() + 1 + cur.units.len());
                    v.extend_from_slice(&p.units);
                    if sep {
                        v.push(SPACE);
                    }
                    v.extend_from_slice(&cur.units);
                    joined = v;
                    &joined
                }
                None => &cur.units,
            };
            match self.query.mode {
                SearchMode::Phrase => {
                    self.push_phrase(comb, plen, prev.is_some(), &pages, &cur, &mut out)
                }
                SearchMode::Proximity => {
                    self.scan_proximity(comb, plen, prev.is_some(), &pages);
                    if let Some(p) = &prev {
                        self.process(p, Some(&cur), false, &mut out);
                    }
                }
            }
        }

        // Windows that start later are anchored in `cur` or beyond.
        let keep_from = cur.base;
        self.pos.retain(|o| o.gs >= keep_from);
        self.excl.retain(|o| o.ge > keep_from);
        self.prev = Some(cur);
        out
    }

    /// No more pages: returns hits still pending on the last page.
    pub fn finish(&mut self) -> Vec<FoundHit> {
        let mut out = Vec::new();
        self.drain(&mut out);
        out
    }

    /// Ends the current run of consecutive pages: resolves everything pending.
    fn drain(&mut self, out: &mut Vec<FoundHit>) {
        if let Some(p) = self.prev.take() {
            if self.query.mode == SearchMode::Proximity {
                self.process(&p, None, true, out);
            }
            self.next_base = p.base + p.len() + 16;
            self.next_lbase = p.lbase + p.ltotal() + 16;
        }
        if let Some(h) = self.held.take() {
            self.sweep_push(h, out);
        }
        if let Some(s) = self.sweep.take() {
            out.push(s.hit);
        }
        self.pos.clear();
        self.excl.clear();
    }

    // --- scanning -----------------------------------------------------------------------------

    /// Occurrences of `pat` in `comb` as `(start, end)` unit ranges. With a
    /// previous page only those ending after `plen` are returned (the others
    /// were found when that page was pushed).
    fn scan(
        &self,
        comb: &[u16],
        plen: usize,
        has_prev: bool,
        pages: &Pages,
        pat: &Pattern,
    ) -> Vec<(usize, usize)> {
        let p = &pat.full;
        let n = comb.len();
        let whole = self.query.whole_word;
        let check_start = is_word_unit(p[0]);
        let check_end = is_word_unit(p[p.len() - 1]);
        let mut out = Vec::new();
        let mut i = if has_prev {
            plen.saturating_sub(2 * p.len() + 2)
        } else {
            0
        };
        while i < n {
            let Some(j) = find_first(comb, i, p[0]) else {
                break;
            };
            if let Some(e) = match_from(comb, j, p, 0) {
                let bounded = !whole
                    || (!(check_start && word_before(comb, j))
                        && !(check_end && word_after(comb, e)));
                if bounded
                    && self.verify(pages, pages.a.base + j as u64, pages.a.base + e as u64, pat)
                {
                    if !has_prev || e > plen {
                        out.push((j, e));
                    }
                    i = e;
                    continue;
                }
            }
            i = j + 1;
        }
        out
    }

    /// Re-checks a candidate against the original chars when the query's fold
    /// is stricter than the index fold (case sensitive / diacritics kept).
    fn verify(&self, pages: &Pages, gs: u64, ge: u64, pat: &Pattern) -> bool {
        let Some(strict) = &pat.strict else {
            return true;
        };
        let mut folder = Folder::new(self.query.fold);
        let mut units: Vec<u16> = Vec::with_capacity((ge - gs) as usize);
        let mut last: Option<(usize, u32)> = None;
        for g in gs..ge {
            match pages.locate(g) {
                Some((slot, w, l)) if w.map[l] != SYNTH => {
                    let o = w.map[l];
                    if last == Some((slot, o)) {
                        continue;
                    }
                    last = Some((slot, o));
                    folder.feed(o, w.index.ch(o), w.index.is_hy(o), &mut |u, _| {
                        units.push(u)
                    });
                }
                _ => folder.feed(0, ' ', false, &mut |u, _| units.push(u)),
            }
        }
        matches_whole(&units, strict)
    }

    fn push_phrase(
        &mut self,
        comb: &[u16],
        plen: usize,
        has_prev: bool,
        pages: &Pages,
        cur: &PageWork,
        out: &mut Vec<FoundHit>,
    ) {
        let q = Arc::clone(&self.query);
        let base = pages.a.base;
        for (s, e) in self.scan(comb, plen, has_prev, pages, &q.terms[0]) {
            let (gs, ge) = (base + s as u64, base + e as u64);
            if gs < self.last_end[0] {
                continue;
            }
            self.last_end[0] = ge;
            let hit_pages = if s < plen {
                *pages
            } else {
                Pages { a: cur, b: None }
            };
            let terms = [TermOcc { term: 0, gs, ge }];
            out.push(build_hit(&hit_pages, gs, ge, &terms, None));
        }
    }

    fn scan_proximity(&mut self, comb: &[u16], plen: usize, has_prev: bool, pages: &Pages) {
        let q = Arc::clone(&self.query);
        let base = pages.a.base;
        for (t, pat) in q.terms.iter().enumerate() {
            for (s, e) in self.scan(comb, plen, has_prev, pages, pat) {
                let (gs, ge) = (base + s as u64, base + e as u64);
                if gs < self.last_end[t] {
                    continue;
                }
                self.last_end[t] = ge;
                self.pos.push(Occ {
                    term: t as u8,
                    gs,
                    ge,
                    ls: pages.lstart(gs),
                    le: pages.lend(ge),
                });
            }
        }
        for (t, pat) in q.excluded.iter().enumerate() {
            for (s, e) in self.scan(comb, plen, has_prev, pages, pat) {
                let (gs, ge) = (base + s as u64, base + e as u64);
                if gs < self.excl_last_end[t] {
                    continue;
                }
                self.excl_last_end[t] = ge;
                self.excl.push(Occ {
                    term: t as u8,
                    gs,
                    ge,
                    ls: 0,
                    le: 0,
                });
            }
        }
        self.pos.sort_by_key(|o| o.gs);
        self.excl.sort_by_key(|o| o.gs);
    }

    // --- proximity windows --------------------------------------------------------------------

    /// Computes the windows anchored in page `p` (they may reach into `q`),
    /// filters them and feeds the overlap sweep. `fin`: nothing follows.
    fn process(&mut self, p: &PageWork, q: Option<&PageWork>, fin: bool, out: &mut Vec<FoundHit>) {
        let pages = Pages { a: p, b: q };
        let k = self.query.terms.len();
        let window = self.query.window as u64;
        let p_end = p.base + p.len();

        let mut per_term: Vec<Vec<usize>> = vec![Vec::new(); k];
        for (i, o) in self.pos.iter().enumerate() {
            per_term[o.term as usize].push(i);
        }
        let mut ptr = vec![0usize; k];
        let mut wins: Vec<Window> = Vec::new();
        for a in &self.pos {
            if a.gs < p.base {
                continue;
            }
            if a.gs >= p_end {
                break;
            }
            let (mut ge, mut le) = (a.ge, a.le);
            let mut complete = true;
            for t in 0..k {
                if t == a.term as usize {
                    continue;
                }
                let list = &per_term[t];
                while ptr[t] < list.len() && self.pos[list[ptr[t]]].gs < a.gs {
                    ptr[t] += 1;
                }
                match list.get(ptr[t]) {
                    Some(&i) => {
                        ge = ge.max(self.pos[i].ge);
                        le = le.max(self.pos[i].le);
                    }
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            if !complete {
                break;
            }
            if wins.last().is_some_and(|w| w.gs == a.gs) {
                continue;
            }
            if le - a.ls > window {
                continue;
            }
            if self.excl.iter().any(|x| x.gs < ge && x.ge > a.gs) {
                continue;
            }
            wins.push(Window {
                gs: a.gs,
                ge,
                ls: a.ls,
                le,
            });
        }

        // The held window is minimal unless the next one ends no later.
        if let Some(h) = self.held.take() {
            match wins.first() {
                Some(w0) => {
                    if w0.ge > h.ge {
                        self.sweep_push(h, out);
                    }
                }
                None if fin => self.sweep_push(h, out),
                None => self.held = Some(h),
            }
        }
        for i in 0..wins.len() {
            let last = i + 1 == wins.len();
            if !last && wins[i + 1].ge <= wins[i].ge {
                continue;
            }
            let built = self.build_window(&pages, &wins[i]);
            if last && !fin {
                self.held = Some(built);
            } else {
                self.sweep_push(built, out);
            }
        }
        if fin {
            if let Some(s) = self.sweep.take() {
                out.push(s.hit);
            }
        }
    }

    fn build_window(&self, pages: &Pages, w: &Window) -> BuiltWindow {
        let from = self.pos.partition_point(|o| o.gs < w.gs);
        let terms: Vec<TermOcc> = self.pos[from..]
            .iter()
            .take_while(|o| o.gs < w.ge)
            .filter(|o| o.ge <= w.ge)
            .map(|o| TermOcc {
                term: o.term,
                gs: o.gs,
                ge: o.ge,
            })
            .collect();
        let len = w.le - w.ls;
        BuiltWindow {
            gs: w.gs,
            ge: w.ge,
            len,
            hit: build_hit(pages, w.gs, w.ge, &terms, Some(len as u32)),
        }
    }

    /// Overlap sweep over minimal windows in start order: of two overlapping
    /// windows the shorter survives (tie: the earlier).
    fn sweep_push(&mut self, w: BuiltWindow, out: &mut Vec<FoundHit>) {
        match self.sweep.take() {
            None => self.sweep = Some(w),
            Some(last) => {
                if w.gs < last.ge {
                    self.sweep = Some(if w.len < last.len { w } else { last });
                } else {
                    out.push(last.hit);
                    self.sweep = Some(w);
                }
            }
        }
    }
}

/// Proximity ordering: by `score` ascending, ties by document position.
pub fn rank(hits: &mut [FoundHit]) {
    hits.sort_by(|a, b| {
        a.hit
            .score
            .unwrap_or(u32::MAX)
            .cmp(&b.hit.score.unwrap_or(u32::MAX))
            .then(a.page.cmp(&b.page))
            .then(a.hit.char_start.cmp(&b.hit.char_start))
    });
}

// ---------------------------------------------------------------------------------------------
// Building a SearchHit
// ---------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Copy)]
struct TermOcc {
    term: u8,
    gs: u64,
    ge: u64,
}

/// Line runs of the units in `gs..ge`: `(page, union of the run's char boxes)`,
/// one per line, whitespace and unboxed chars ignored.
fn runs(pages: &Pages, gs: u64, ge: u64) -> Vec<(u32, BoxF)> {
    let mut out: Vec<(u32, usize, BoxF)> = Vec::new();
    for g in gs..ge {
        let Some((_, w, l)) = pages.locate(g) else {
            continue;
        };
        let o = w.map[l];
        if o == SYNTH || w.index.ch(o).is_whitespace() {
            continue;
        }
        let (Some(b), Some(line)) = (w.index.box_of(o), w.index.line_of(o)) else {
            continue;
        };
        let page = w.index.page();
        match out.last_mut() {
            Some((p, ln, r)) if *p == page && *ln == line => *r = r.union(&b),
            _ => out.push((page, line, b)),
        }
    }
    out.into_iter().map(|(p, _, b)| (p, b)).collect()
}

/// Collapsed display text (what the result list shows).
#[derive(Default)]
struct Disp {
    chars: Vec<char>,
    /// The last thing shown was a line-end hyphen: the line break that follows
    /// it (possibly on the next page) is not a word separator.
    after_hy: bool,
}

impl Disp {
    fn space(&mut self) {
        if self.chars.last() != Some(&' ') {
            self.chars.push(' ');
        }
    }
}

/// Appends the display text of `range` of one page. Excluded chars are
/// absent, a line-end hyphen shows as `-` and swallows the break after it.
/// `offs` receives, for every char of the range (plus one at the end), the
/// display length before it.
fn walk(disp: &mut Disp, w: &PageWork, range: Range<u32>, mut offs: Option<&mut Vec<u32>>) {
    let idx = &w.index;
    for o in range {
        if let Some(v) = offs.as_mut() {
            v.push(disp.chars.len() as u32);
        }
        if w.is_excluded(o) {
            continue;
        }
        let c = idx.ch(o);
        if idx.is_hy(o) {
            disp.chars.push('-');
            disp.after_hy = true;
            continue;
        }
        if disp.after_hy && (c == '\r' || c == '\n') {
            continue;
        }
        disp.after_hy = false;
        if normalize::is_zero_width(c) {
            continue;
        }
        if normalize::is_blank(c) {
            disp.space();
        } else {
            disp.chars.push(c);
        }
    }
    if let Some(v) = offs {
        v.push(disp.chars.len() as u32);
    }
}

/// Elides the middle of an over-long `matched`, clipping the term ranges.
fn elide(
    chars: Vec<char>,
    ranges: Vec<(usize, usize, u8)>,
) -> (Vec<char>, Vec<(usize, usize, u8)>) {
    let n = chars.len();
    if n <= MATCHED_MAX {
        return (chars, ranges);
    }
    let mut out = Vec::with_capacity(ELIDE_KEEP * 2 + 3);
    out.extend_from_slice(&chars[..ELIDE_KEEP]);
    out.extend([' ', '…', ' ']);
    out.extend_from_slice(&chars[n - ELIDE_KEEP..]);
    let tail_start = n - ELIDE_KEEP;
    let shift = ELIDE_KEEP + 3;
    let mut clipped = Vec::new();
    for (s, e, t) in ranges {
        let (s1, e1) = (s.min(ELIDE_KEEP), e.min(ELIDE_KEEP));
        if e1 > s1 {
            clipped.push((s1, e1, t));
        }
        let (s2, e2) = (s.max(tail_start), e.max(tail_start));
        if e2 > s2 {
            clipped.push((s2 - tail_start + shift, e2 - tail_start + shift, t));
        }
    }
    clipped.sort_by_key(|r| r.0);
    (out, clipped)
}

fn build_context(
    pages: &Pages,
    os: u32,
    o_last: u32,
    spans: bool,
    terms: &[TermOcc],
) -> SearchContext {
    let a = pages.a;
    let mut disp = Disp::default();
    let mut offs_a = Vec::new();
    let mut offs_b = Vec::new();
    let a_end = if spans {
        a.index.char_count()
    } else {
        o_last + 1
    };
    walk(&mut disp, a, os..a_end, Some(&mut offs_a));
    if let (true, Some(b)) = (spans, pages.b) {
        if b.base > a.base + a.len() {
            disp.space();
        }
        walk(&mut disp, b, 0..o_last + 1, Some(&mut offs_b));
    }

    let pos_of = |g: u64, end: bool| -> Option<usize> {
        let (slot, w, l) = pages.locate(g)?;
        let o = w.map[l];
        if o == SYNTH {
            return None;
        }
        let (from, offs) = if slot == 0 {
            (os, &offs_a)
        } else {
            (0, &offs_b)
        };
        offs.get((o - from) as usize + end as usize)
            .map(|&v| v as usize)
    };
    let mut ranges: Vec<(usize, usize, u8)> = terms
        .iter()
        .filter_map(|t| Some((pos_of(t.gs, false)?, pos_of(t.ge - 1, true)?, t.term)))
        .collect();
    while disp.chars.last() == Some(&' ') {
        disp.chars.pop();
    }
    let len = disp.chars.len();
    for r in &mut ranges {
        r.1 = r.1.min(len);
        r.0 = r.0.min(r.1);
    }
    let (matched, ranges) = elide(disp.chars, ranges);

    let mut utf16 = Vec::with_capacity(matched.len() + 1);
    let mut acc = 0u32;
    for c in &matched {
        utf16.push(acc);
        acc += c.len_utf16() as u32;
    }
    utf16.push(acc);
    let context_terms = ranges
        .into_iter()
        .map(|(s, e, term)| ContextTerm {
            start: utf16[s],
            len: utf16[e] - utf16[s],
            term,
        })
        .collect();

    let before = {
        let mut d = Disp::default();
        walk(&mut d, a, os.saturating_sub(CONTEXT_LOOKAROUND)..os, None);
        let from = d.chars.len().saturating_sub(CONTEXT_CHARS);
        let s: String = d.chars[from..].iter().collect();
        s.trim_start().to_owned()
    };
    let after = {
        let end_page = if spans { pages.b.unwrap_or(a) } else { a };
        let from = o_last + 1;
        let to = from
            .saturating_add(CONTEXT_LOOKAROUND)
            .min(end_page.index.char_count());
        let mut d = Disp::default();
        if from < to {
            walk(&mut d, end_page, from..to, None);
        }
        let s: String = d.chars.iter().take(CONTEXT_CHARS).collect();
        s.trim_end().to_owned()
    };

    SearchContext {
        before,
        matched: matched.into_iter().collect(),
        after,
        terms: context_terms,
    }
}

fn build_hit(pages: &Pages, gs: u64, ge: u64, terms: &[TermOcc], score: Option<u32>) -> FoundHit {
    let a = pages.a;
    let (_, _, first) = pages.locate(gs).expect("hit start unit");
    let os = a.map[first];
    let (end_slot, ew, end_local) = pages.locate(ge - 1).expect("hit end unit");
    let o_last = ew.map[end_local];
    let spans = end_slot == 1;

    let mut rects = Vec::new();
    for t in terms {
        for (page, b) in runs(pages, t.gs, t.ge) {
            rects.push(HitRect {
                page,
                rect: b.to_rect(),
                term: t.term,
            });
        }
    }
    let window_rects = if score.is_some() {
        runs(pages, gs, ge)
            .into_iter()
            .map(|(page, b)| PageRect {
                page,
                rect: b.to_rect(),
            })
            .collect()
    } else {
        Vec::new()
    };

    FoundHit {
        page: a.index.page(),
        hit: SearchHit {
            rects,
            char_start: os,
            char_len: if spans {
                a.index.char_count() - os
            } else {
                o_last + 1 - os
            },
            context: build_context(pages, os, o_last, spans, terms),
            window_rects,
            score,
            spans_pages: spans.then(|| (a.index.page(), ew.index.page())),
            outline_item_id: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::super::index::test_support::index;
    use super::*;
    use crate::types::{ProximityOptions, RubricaErrorCode, SearchScope};

    // --- helpers -----------------------------------------------------------------------------

    fn phrase(text: &str) -> SearchQuery {
        SearchQuery {
            text: text.to_owned(),
            mode: SearchMode::Phrase,
            proximity: None,
            scope: SearchScope::All,
            case_sensitive: false,
            whole_word: false,
            ignore_diacritics: true,
            exclude_headers_footers: false,
        }
    }

    fn prox(text: &str, window: u32) -> SearchQuery {
        SearchQuery {
            mode: SearchMode::Proximity,
            proximity: Some(ProximityOptions { window }),
            ..phrase(text)
        }
    }

    /// Char index of `needle` in the raw page built from `text` (`\n` is 2 chars).
    fn pos(text: &str, needle: &str) -> u32 {
        let byte = text
            .find(needle)
            .unwrap_or_else(|| panic!("{needle:?} not in {text:?}"));
        text[..byte]
            .chars()
            .map(|c| if c == '\n' { 2 } else { 1 })
            .sum()
    }

    fn span(text: &str, needle: &str) -> Range<u32> {
        let s = pos(text, needle);
        let len: u32 = needle.chars().map(|c| if c == '\n' { 2 } else { 1 }).sum();
        s..s + len
    }

    type Page<'a> = (u32, &'a str, Vec<Range<u32>>);

    fn run_pages(q: &SearchQuery, pages: &[Page]) -> Vec<FoundHit> {
        let compiled = Arc::new(compile(q).expect("valid query"));
        let mut m = Matcher::new(compiled);
        let mut out = Vec::new();
        for (page, text, excluded) in pages {
            out.extend(m.push_page(index(*page, text), excluded));
        }
        out.extend(m.finish());
        out
    }

    fn run(q: &SearchQuery, text: &str) -> Vec<FoundHit> {
        run_pages(q, &[(0, text, vec![])])
    }

    fn starts(hits: &[FoundHit]) -> Vec<u32> {
        hits.iter().map(|h| h.hit.char_start).collect()
    }

    fn scores(hits: &[FoundHit]) -> Vec<u32> {
        hits.iter().map(|h| h.hit.score.unwrap()).collect()
    }

    fn err_code(q: &SearchQuery) -> RubricaErrorCode {
        compile(q).expect_err("must be rejected").code
    }

    // --- compile ------------------------------------------------------------------------------

    #[test]
    fn compile_rejects_bad_queries_with_invalid_arg() {
        assert_eq!(err_code(&phrase("")), RubricaErrorCode::InvalidArg);
        assert_eq!(err_code(&phrase("   \t")), RubricaErrorCode::InvalidArg);
        assert_eq!(
            err_code(&phrase("\u{AD}\u{200B}")),
            RubricaErrorCode::InvalidArg
        );
        assert_eq!(err_code(&prox("", 500)), RubricaErrorCode::InvalidArg);
        assert_eq!(err_code(&prox("-foo", 500)), RubricaErrorCode::InvalidArg);
        assert_eq!(
            err_code(&prox("-foo -\"bar baz\"", 500)),
            RubricaErrorCode::InvalidArg
        );
        assert_eq!(
            err_code(&prox("\"\" \"  \"", 500)),
            RubricaErrorCode::InvalidArg
        );
        assert_eq!(err_code(&prox("a b", 19)), RubricaErrorCode::InvalidArg);
        assert_eq!(err_code(&prox("a b", 5001)), RubricaErrorCode::InvalidArg);
        assert_eq!(err_code(&prox("a b", 0)), RubricaErrorCode::InvalidArg);
        let mut missing = prox("a b", 500);
        missing.proximity = None;
        assert_eq!(err_code(&missing), RubricaErrorCode::InvalidArg);
    }

    #[test]
    fn compile_accepts_the_window_limits() {
        assert!(compile(&prox("a b", 20)).is_ok());
        assert!(compile(&prox("a b", 5000)).is_ok());
    }

    #[test]
    fn phrase_mode_ignores_a_stray_proximity_block() {
        let mut q = phrase("contrato");
        q.proximity = Some(ProximityOptions { window: 3 });
        let c = compile(&q).unwrap();
        assert_eq!(c.mode(), SearchMode::Phrase);
        assert_eq!(c.term_count(), 1);
    }

    #[test]
    fn proximity_syntax() {
        let c = compile(&prox("alfa \"fazer cessar\" -gama -\"x y\" beta -", 100)).unwrap();
        assert_eq!(c.mode(), SearchMode::Proximity);
        // positives: alfa, "fazer cessar", beta, "-" (a lone dash is a literal term)
        assert_eq!(c.term_count(), 4);
        assert_eq!(c.excluded.len(), 2);
        assert_eq!(
            c.terms[1].full,
            normalize::fold_text("fazer cessar", Fold::INDEX)
        );
        // curly quotes group too
        let c = compile(&prox("\u{201C}fazer cessar\u{201D} beta", 100)).unwrap();
        assert_eq!(c.term_count(), 2);
        // an unterminated quote runs to the end
        let c = compile(&prox("beta \"fazer cessar", 100)).unwrap();
        assert_eq!(c.term_count(), 2);
    }

    #[test]
    fn identical_terms_count_once() {
        let c = compile(&prox("alfa beta ALFA", 100)).unwrap();
        assert_eq!(c.term_count(), 2);
    }

    // --- phrase mode ----------------------------------------------------------------------------

    #[test]
    fn phrase_finds_every_occurrence_with_positions_and_rects() {
        let text = "um contrato e outro contrato";
        let hits = run(&phrase("contrato"), text);
        assert_eq!(starts(&hits), vec![pos(text, "contrato"), 20]);
        for h in &hits {
            assert_eq!(h.page, 0);
            assert_eq!(h.hit.char_len, 8);
            assert_eq!(h.hit.rects.len(), 1);
            assert_eq!(h.hit.rects[0].term, 0);
            assert_eq!(h.hit.rects[0].page, 0);
            assert!(h.hit.window_rects.is_empty());
            assert!(h.hit.score.is_none());
            assert!(h.hit.spans_pages.is_none());
            assert!(h.hit.outline_item_id.is_none());
            assert_eq!(h.hit.context.matched, "contrato");
            assert_eq!(h.hit.context.terms.len(), 1);
            assert_eq!(h.hit.context.terms[0].start, 0);
            assert_eq!(h.hit.context.terms[0].len, 8);
        }
        // Rect = union of the char boxes: x from 36 + 3*6, 8 chars of 5pt on a 6pt pitch.
        let r = &hits[0].hit.rects[0].rect;
        assert!((r.x - (36.0 + 3.0 * 6.0)).abs() < 0.05, "{r:?}");
        assert!((r.width - (7.0 * 6.0 + 5.0)).abs() < 0.05);
        assert!((r.height - 10.0).abs() < 0.05);
        assert!((r.y - 700.0).abs() < 0.05);
    }

    #[test]
    fn phrase_hits_do_not_overlap() {
        assert_eq!(run(&phrase("aa"), "aaaa").len(), 2);
        assert_eq!(run(&phrase("aa"), "aaa").len(), 1);
    }

    #[test]
    fn case_is_ignored_by_default_and_respected_when_asked() {
        let text = "Contrato contrato CONTRATO";
        assert_eq!(run(&phrase("contrato"), text).len(), 3);
        assert_eq!(run(&phrase("CONTRATO"), text).len(), 3);
        let mut q = phrase("contrato");
        q.case_sensitive = true;
        assert_eq!(starts(&run(&q, text)), vec![9]);
        q.text = "Contrato".into();
        assert_eq!(starts(&run(&q, text)), vec![0]);
        q.text = "CONTRATO".into();
        assert_eq!(starts(&run(&q, text)), vec![18]);
    }

    #[test]
    fn diacritics_match_both_ways_by_default() {
        let text = "a ação, a acao e a AÇÃO; também Acão";
        assert_eq!(run(&phrase("acao"), text).len(), 4);
        assert_eq!(run(&phrase("ação"), text).len(), 4);
        assert_eq!(run(&phrase("AÇÃO"), text).len(), 4);
        assert_eq!(run(&phrase("açao"), text).len(), 4);
    }

    #[test]
    fn diacritic_sensitive_queries_only_match_the_same_accents() {
        let text = "a ação, a acao e a AÇÃO; também Acão";
        let mut q = phrase("acao");
        q.ignore_diacritics = false;
        assert_eq!(starts(&run(&q, text)), vec![pos(text, "acao")]);
        q.text = "ação".into();
        // case-insensitive: "ação" and "AÇÃO"; not "Acão" (no cedilla)
        assert_eq!(run(&q, text).len(), 2);
        q.text = "acão".into();
        assert_eq!(starts(&run(&q, text)), vec![pos(text, "Acão")]);
    }

    #[test]
    fn case_and_diacritic_sensitivity_combine() {
        let text = "Ação ação AÇÃO acao";
        let mut q = phrase("Ação");
        q.case_sensitive = true;
        q.ignore_diacritics = false;
        assert_eq!(starts(&run(&q, text)), vec![0]);
        q.ignore_diacritics = true;
        // accents stripped, case kept: "Ação" ~ "Acao" only
        assert_eq!(starts(&run(&q, text)), vec![0]);
        q.text = "acao".into();
        assert_eq!(starts(&run(&q, text)), vec![5, 15]);
    }

    #[test]
    fn ligatures_match_in_both_forms() {
        // codepoint ligature in the PDF text, plain letters in the query, and vice versa
        let text = "a e\u{FB01}c\u{E1}cia e o \u{FB02}uxo; efic\u{E1}cia e fluxo";
        assert_eq!(run(&phrase("eficácia"), text).len(), 2);
        assert_eq!(run(&phrase("eficacia"), text).len(), 2);
        assert_eq!(run(&phrase("fluxo"), text).len(), 2);
        assert_eq!(run(&phrase("e\u{FB01}c\u{E1}cia"), text).len(), 2);
        // PDFium's already-expanded form: two chars sharing one box
        assert_eq!(run(&phrase("fluxo"), "o fluxo").len(), 1);
    }

    #[test]
    fn curly_quotes_match_straight_quotes_and_back() {
        let text = "constitua \u{201C}justa causa\u{201D}, nos termos";
        assert_eq!(run(&phrase("\"justa causa\""), text).len(), 1);
        assert_eq!(run(&phrase("\u{201C}justa causa\u{201D}"), text).len(), 1);
        assert_eq!(run(&phrase("justa causa"), text).len(), 1);
        assert_eq!(run(&phrase("it's"), "it\u{2019}s here").len(), 1);
    }

    #[test]
    fn nbsp_and_whitespace_runs_match_a_plain_space() {
        let text = "nos termos do art.\u{A0}12.º do código";
        assert_eq!(run(&phrase("art. 12.º"), text).len(), 1);
        assert_eq!(run(&phrase("art.\u{A0}12.º"), text).len(), 1);
        assert_eq!(
            run(&phrase("do   art."), text).len(),
            1,
            "query runs collapse too"
        );
        assert_eq!(run(&phrase("lazy dog"), "the lazy \t  dog").len(), 1);
    }

    #[test]
    fn a_phrase_matches_across_a_line_break_with_one_rect_per_line() {
        let text = "alpha beta lazy\ndog epsilon";
        let hits = run(&phrase("lazy dog"), text);
        assert_eq!(hits.len(), 1);
        let h = &hits[0].hit;
        assert_eq!(h.char_start, pos(text, "lazy"));
        assert_eq!(h.char_len, 4 + 2 + 3, "lazy + \\r\\n + dog");
        assert_eq!(h.rects.len(), 2, "one rect per line run");
        assert!(h.rects[0].rect.y > h.rects[1].rect.y, "first line is above");
        assert!((h.rects[0].rect.width - (3.0 * 6.0 + 5.0)).abs() < 0.05);
        assert!((h.rects[1].rect.width - (2.0 * 6.0 + 5.0)).abs() < 0.05);
        assert_eq!(h.context.matched, "lazy dog");
        assert_eq!(h.context.terms[0].len, 8);
    }

    #[test]
    fn soft_hyphen_chars_vanish() {
        assert_eq!(run(&phrase("obrigações"), "as obriga\u{AD}ções").len(), 1);
        assert_eq!(run(&phrase("obriga\u{AD}ções"), "as obrigações").len(), 1);
    }

    #[test]
    fn line_end_hyphen_matches_with_and_without_the_hyphen() {
        // PDFium: a single U+0002 in place of the hyphen, no line break.
        let text = "o presente contra\u{2}to e o pré\u{2}aviso final";
        for (query, expected) in [
            ("contrato", 1),
            ("contra-to", 1),
            ("contra to", 0),
            ("pré-aviso", 1),
            ("préaviso", 1),
            ("pre-aviso", 1),
            ("preaviso", 1),
            ("presente contrato e", 1),
            ("contrato e o pré-aviso", 1),
            ("contra-to e o préaviso", 1),
            ("contra--to", 0),
        ] {
            assert_eq!(run(&phrase(query), text).len(), expected, "{query}");
        }
        // the hit covers the marker char and boxes it
        let hits = run(&phrase("contrato"), text);
        assert_eq!(hits[0].hit.char_len, 9);
        assert_eq!(hits[0].hit.context.matched, "contra-to");
    }

    #[test]
    fn line_end_hyphen_on_two_real_lines_gets_one_rect_per_line() {
        let text = "pre contra\u{2}\nto fim";
        // PDFium would not emit the \n, but the line grouping still splits on y.
        let hits = run(&phrase("contrato"), text);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.rects.len(), 2);
    }

    #[test]
    fn plain_hyphen_at_a_line_end_is_optional_too() {
        let text = "o contra-\nto e o pré-\naviso aqui";
        assert_eq!(run(&phrase("contrato"), text).len(), 1);
        assert_eq!(run(&phrase("contra-to"), text).len(), 1);
        assert_eq!(run(&phrase("pré-aviso"), text).len(), 1);
        assert_eq!(run(&phrase("préaviso"), text).len(), 1);
    }

    #[test]
    fn a_mid_line_hyphen_is_a_real_hyphen() {
        let text = "o pré-aviso e o contrato";
        assert_eq!(run(&phrase("pré-aviso"), text).len(), 1);
        assert_eq!(run(&phrase("préaviso"), text).len(), 0);
        assert_eq!(run(&phrase("contra-to"), text).len(), 0);
        // and a spaced one is not a marker either
        assert_eq!(run(&phrase("contrato"), "contra - to").len(), 0);
    }

    #[test]
    fn whole_word_respects_word_edges() {
        let mut q = phrase("contrato");
        q.whole_word = true;
        let text = "contrato contratos subcontrato (contrato) contrato. contrato-x 5contrato";
        // "contrato", "(contrato)", "contrato.", "contrato-x"
        assert_eq!(run(&q, text).len(), 4);
        q.text = "ação".into();
        assert_eq!(run(&q, "ação ações acção").len(), 1);
        q.text = "acao".into();
        assert_eq!(
            run(&q, "ação notificação").len(),
            1,
            "accent-folded, still whole word"
        );
    }

    #[test]
    fn whole_word_is_off_by_default() {
        assert_eq!(run(&phrase("contrato"), "contratos subcontrato").len(), 2);
    }

    #[test]
    fn whole_word_treats_a_line_end_hyphen_as_joining_the_word() {
        let mut q = phrase("contrato");
        q.whole_word = true;
        assert_eq!(run(&q, "um contra\u{2}to aqui").len(), 1);
        q.text = "contra".into();
        assert_eq!(run(&q, "um contra\u{2}to aqui").len(), 0);
        q.text = "to".into();
        assert_eq!(run(&q, "um contra\u{2}to aqui").len(), 0);
        q.text = "pré".into();
        assert_eq!(
            run(&q, "um pré-aviso aqui").len(),
            1,
            "mid-line hyphen separates words"
        );
    }

    #[test]
    fn whole_word_only_checks_edges_that_are_word_chars() {
        let mut q = phrase("art.");
        q.whole_word = true;
        assert_eq!(run(&q, "ver art. 12 e part. 3").len(), 1);
        q.text = ".º".into();
        assert_eq!(run(&q, "12.º e 5.º").len(), 2);
    }

    #[test]
    fn whole_word_with_strict_case() {
        let mut q = phrase("Contrato");
        q.whole_word = true;
        q.case_sensitive = true;
        assert_eq!(run(&q, "Contrato contrato Contratos").len(), 1);
    }

    #[test]
    fn context_before_and_after_are_trimmed_and_collapsed() {
        let words: Vec<String> = (0..40).map(|i| format!("w{i:02}")).collect();
        let text = format!(
            "{}  NEEDLE\n\n{}",
            words[..20].join(" "),
            words[20..].join(" ")
        );
        let h = &run(&phrase("needle"), &text)[0].hit;
        assert_eq!(h.context.matched, "NEEDLE");
        assert!(
            h.context.before.ends_with("w19 "),
            "keeps the boundary space: {:?}",
            h.context.before
        );
        assert!(h.context.after.starts_with(" w20"), "{:?}", h.context.after);
        assert!(h.context.before.chars().count() <= 60);
        assert!(h.context.after.chars().count() <= 60);
        assert!(h.context.before.chars().count() > 50);
        assert!(!h.context.before.contains("  "));
        assert!(!h.context.after.contains('\n'));
        assert!(!h.context.before.starts_with(' '));
        assert!(!h.context.after.ends_with(' '));
    }

    #[test]
    fn context_at_the_page_edges_is_short_not_padded() {
        let h = &run(&phrase("needle"), "needle")[0].hit;
        assert_eq!(h.context.before, "");
        assert_eq!(h.context.after, "");
    }

    #[test]
    fn context_counts_chars_not_bytes() {
        let text = format!("{}NEEDLE{}", "ã".repeat(80), "é".repeat(80));
        let h = &run(&phrase("needle"), &text)[0].hit;
        assert_eq!(h.context.before, "ã".repeat(60));
        assert_eq!(h.context.after, "é".repeat(60));
    }

    #[test]
    fn phrase_term_offsets_are_utf16() {
        let text = "😀 ação 😀 contrato";
        let h = &run(&phrase("ação 😀 contrato"), text)[0].hit;
        assert_eq!(h.context.matched, "ação 😀 contrato");
        assert_eq!(h.context.terms.len(), 1);
        assert_eq!(h.context.terms[0].start, 0);
        assert_eq!(
            h.context.terms[0].len,
            "ação 😀 contrato".encode_utf16().count() as u32
        );
        assert_eq!(h.context.before, "😀 ");
    }

    #[test]
    fn a_long_phrase_is_elided_in_the_middle() {
        let long = format!("alfa {} omega", "x ".repeat(100));
        let h = &run(&phrase(&long), &long)[0].hit;
        let m: Vec<char> = h.context.matched.chars().collect();
        assert_eq!(m.len(), ELIDE_KEEP * 2 + 3);
        assert_eq!(&m[ELIDE_KEEP..ELIDE_KEEP + 3], &[' ', '…', ' ']);
        assert!(h.context.matched.starts_with("alfa x"));
        assert!(h.context.matched.ends_with("x omega"));
        // two visible pieces, none touching the elision
        assert_eq!(h.context.terms.len(), 2);
        assert_eq!(h.context.terms[0].start, 0);
        assert_eq!(h.context.terms[0].len, ELIDE_KEEP as u32);
        assert_eq!(h.context.terms[1].start, ELIDE_KEEP as u32 + 3);
        assert_eq!(h.context.terms[1].len, ELIDE_KEEP as u32);
    }

    // --- phrase: pages and exclusions -----------------------------------------------------------

    const P22: &str =
        "corpo da pagina\nQuando for esse o caso, a parte que pretenda fazer cessar\nPágina 22 de 40";
    const P23: &str = "Manual de Contratos\no acordo deve comunicá-lo por escrito\nPágina 23 de 40";

    fn cross_page_pages(excluded: bool) -> Vec<Page<'static>> {
        let ex = |text: &'static str, needles: &[&str]| -> Vec<Range<u32>> {
            if excluded {
                needles.iter().map(|n| span(text, n)).collect()
            } else {
                Vec::new()
            }
        };
        vec![
            (21, P22, ex(P22, &["Página 22 de 40"])),
            (
                22,
                P23,
                ex(P23, &["Manual de Contratos", "Página 23 de 40"]),
            ),
        ]
    }

    #[test]
    fn a_phrase_joins_across_a_page_break_when_the_furniture_is_excluded() {
        let hits = run_pages(&phrase("fazer cessar o acordo"), &cross_page_pages(true));
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(h.page, 21);
        assert_eq!(h.hit.spans_pages, Some((21, 22)));
        assert_eq!(h.hit.char_start, pos(P22, "fazer"));
        // length stops at the start page's end
        assert_eq!(
            h.hit.char_len,
            index(21, P22).char_count() - pos(P22, "fazer")
        );
        assert_eq!(h.hit.context.matched, "fazer cessar o acordo");
        let pages: Vec<u32> = h.hit.rects.iter().map(|r| r.page).collect();
        assert_eq!(pages, vec![21, 22], "one rect per line run, on each page");
        assert!(h.hit.context.before.ends_with("pretenda "));
        assert!(
            h.hit.context.after.starts_with(" deve comunicá-lo"),
            "{:?}",
            h.hit.context.after
        );
    }

    #[test]
    fn a_phrase_does_not_join_across_furniture_that_is_not_excluded() {
        assert!(run_pages(&phrase("fazer cessar o acordo"), &cross_page_pages(false)).is_empty());
        // with the footer/header text in between, that text is the phrase
        let hits = run_pages(
            &phrase("fazer cessar Página 22 de 40 Manual de Contratos o acordo"),
            &cross_page_pages(false),
        );
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn the_hit_is_returned_when_its_last_page_is_pushed() {
        let compiled = Arc::new(compile(&phrase("fazer cessar o acordo")).unwrap());
        let mut m = Matcher::new(compiled);
        let pages = cross_page_pages(true);
        assert!(m
            .push_page(index(pages[0].0, pages[0].1), &pages[0].2)
            .is_empty());
        assert_eq!(
            m.push_page(index(pages[1].0, pages[1].1), &pages[1].2)
                .len(),
            1
        );
        assert!(m.finish().is_empty());
    }

    #[test]
    fn a_phrase_never_continues_past_the_next_page() {
        let pages: Vec<Page> = vec![
            (0, "alfa beta", vec![]),
            (1, "gama", vec![]),
            (2, "delta epsilon", vec![]),
        ];
        assert!(run_pages(&phrase("beta gama delta"), &pages).is_empty());
        assert_eq!(run_pages(&phrase("beta gama"), &pages).len(), 1);
        assert_eq!(run_pages(&phrase("gama delta"), &pages).len(), 1);
    }

    #[test]
    fn a_gap_in_the_pushed_pages_resets_the_carry() {
        let consecutive: Vec<Page> =
            vec![(4, "o fim da frase", vec![]), (5, "continua aqui", vec![])];
        assert_eq!(run_pages(&phrase("frase continua"), &consecutive).len(), 1);
        let gap: Vec<Page> = vec![(4, "o fim da frase", vec![]), (6, "continua aqui", vec![])];
        assert!(run_pages(&phrase("frase continua"), &gap).is_empty());
    }

    #[test]
    fn a_phrase_joins_across_a_removed_block_inside_a_page() {
        let text = "fazer\nRODAPE 3\ncessar o acordo";
        let ex = vec![span(text, "RODAPE 3")];
        let pages: Vec<Page> = vec![(0, text, ex)];
        let hits = run_pages(&phrase("fazer cessar o acordo"), &pages);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.context.matched, "fazer cessar o acordo");
        assert_eq!(hits[0].hit.rects.len(), 2, "the excluded line gets no rect");
        let pages: Vec<Page> = vec![(0, text, vec![])];
        assert!(run_pages(&phrase("fazer cessar o acordo"), &pages).is_empty());
    }

    #[test]
    fn excluded_text_is_never_matched() {
        let text = "Manual\ncorpo manual";
        let pages: Vec<Page> = vec![(0, text, vec![span(text, "Manual")])];
        let hits = run_pages(&phrase("manual"), &pages);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.char_start, pos(text, "corpo manual") + 6);
    }

    #[test]
    fn excluded_ranges_may_be_unsorted_overlapping_or_empty() {
        let text = "aa\nbb\ncc dd";
        let ex = vec![
            span(text, "cc"),
            5..5,
            span(text, "bb"),
            span(text, "bb\ncc"),
        ];
        let pages: Vec<Page> = vec![(0, text, ex)];
        assert_eq!(run_pages(&phrase("aa dd"), &pages).len(), 1);
    }

    #[test]
    fn a_line_end_hyphen_joins_across_the_page_break_and_removed_furniture() {
        let p0 = "ola contra\u{2}\nPagina 1";
        let p1 = "Cabecalho\nto fim";
        let pages: Vec<Page> = vec![
            (0, p0, vec![span(p0, "Pagina 1")]),
            (1, p1, vec![span(p1, "Cabecalho")]),
        ];
        let hits = run_pages(&phrase("contrato"), &pages);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.spans_pages, Some((0, 1)));
        assert_eq!(hits[0].hit.context.matched, "contra-to");
        assert_eq!(run_pages(&phrase("contra-to"), &pages).len(), 1);
        // not excluded: the footer text is in the way
        let pages: Vec<Page> = vec![(0, p0, vec![]), (1, p1, vec![])];
        assert!(run_pages(&phrase("contrato"), &pages).is_empty());
    }

    #[test]
    fn case_sensitive_phrase_across_a_page_break() {
        let pages: Vec<Page> = vec![(0, "x Fazer Cessar", vec![]), (1, "O Acordo y", vec![])];
        let mut q = phrase("Fazer Cessar O Acordo");
        q.case_sensitive = true;
        assert_eq!(run_pages(&q, &pages).len(), 1);
        q.text = "fazer Cessar O Acordo".into();
        assert!(run_pages(&q, &pages).is_empty());
    }

    #[test]
    fn a_term_that_straddles_the_break_is_found_once() {
        // The tail of a page is rescanned each round; a straddling match must
        // still be reported exactly once.
        let pages: Vec<Page> = vec![
            (0, "x fim", vec![]),
            (1, "inicio y", vec![]),
            (2, "fim inicio", vec![]),
        ];
        let hits = run_pages(&phrase("fim inicio"), &pages);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].page, 0);
        assert_eq!(hits[1].page, 2);
    }

    #[test]
    fn empty_and_blank_pages_are_harmless() {
        let pages: Vec<Page> = vec![
            (0, "", vec![]),
            (1, "\n\n", vec![]),
            (2, "contrato", vec![]),
            (3, "", vec![]),
            (4, "contrato", vec![]),
        ];
        let hits = run_pages(&phrase("contrato"), &pages);
        assert_eq!(hits.iter().map(|h| h.page).collect::<Vec<_>>(), vec![2, 4]);
        let hits = run_pages(&prox("contrato", 50), &pages);
        assert_eq!(hits.iter().map(|h| h.page).collect::<Vec<_>>(), vec![2, 4]);
    }

    // --- proximity ----------------------------------------------------------------------------

    fn two_words(filler: usize) -> String {
        format!("alfa {} beta", "x".repeat(filler))
    }

    #[test]
    fn a_window_exactly_at_n_is_found_and_n_plus_one_is_not() {
        // length = 4 + 1 + filler + 1 + 4
        for n in [20u32, 21, 100, 499, 500, 1000, 5000] {
            let filler = n as usize - 10;
            let text = two_words(filler);
            let at = run(&prox("alfa beta", n), &text);
            assert_eq!(scores(&at), vec![n], "window == N={n}");
            if n > WINDOW_MIN {
                assert!(
                    run(&prox("alfa beta", n - 1), &text).is_empty(),
                    "N-1={}",
                    n - 1
                );
            }
        }
        // one char more than the minimum window is out for N = 20
        assert!(run(&prox("alfa beta", 20), &two_words(11)).is_empty());
    }

    #[test]
    fn the_window_length_counts_whitespace_runs_as_one() {
        let text = "alfa      \t   beta";
        assert_eq!(scores(&run(&prox("alfa beta", 20), text)), vec![9]);
        let text = "alfa\nbeta";
        assert_eq!(scores(&run(&prox("alfa beta", 20), text)), vec![9]);
        let text = "alfa\n\n\n  beta";
        assert_eq!(scores(&run(&prox("alfa beta", 20), text)), vec![9]);
    }

    #[test]
    fn the_window_length_ignores_the_line_end_hyphen_marker() {
        let text = "alfa x contra\u{2}to beta";
        let hits = run(&prox("alfa contrato beta", 100), text);
        assert_eq!(scores(&hits), vec!["alfa x contrato beta".len() as u32]);
    }

    #[test]
    fn terms_may_come_in_any_order_and_all_must_be_present() {
        let text = "gama x alfa y beta";
        assert_eq!(run(&prox("alfa beta gama", 100), text).len(), 1);
        assert_eq!(run(&prox("alfa beta gama delta", 100), text).len(), 0);
        let hit = &run(&prox("alfa beta gama", 100), text)[0].hit;
        assert_eq!(hit.score, Some(text.len() as u32));
        // term index = position in the query, not in the text
        let order: Vec<u8> = hit.rects.iter().map(|r| r.term).collect();
        assert_eq!(order, vec![2, 0, 1]);
    }

    #[test]
    fn only_minimal_windows_are_reported() {
        // alfa alfa beta: the window from the first alfa has the second inside.
        let text = "alfa alfa beta";
        let hits = run(&prox("alfa beta", 100), text);
        assert_eq!(starts(&hits), vec![5]);
        assert_eq!(scores(&hits), vec![9]);
        // beta beta alfa: only the second beta pairs tightly
        let text = "beta beta alfa";
        let hits = run(&prox("alfa beta", 100), text);
        assert_eq!(starts(&hits), vec![5]);
    }

    #[test]
    fn repeated_terms_give_one_window_per_tight_pair() {
        let text = "alfa beta ... ... ... ... ... alfa beta";
        let hits = run(&prox("alfa beta", 30), text);
        assert_eq!(starts(&hits), vec![0, pos(text, "alfa beta") + 30]);
        assert_eq!(scores(&hits), vec![9, 9]);
    }

    #[test]
    fn overlapping_windows_keep_the_shorter() {
        // W1 = alfa..beta (long), W2 = beta..alfa (short) overlap on "beta".
        let text = "alfa xxxxxxxxxxxx beta alfa";
        let hits = run(&prox("alfa beta", 100), text);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.char_start, pos(text, "beta"));
        assert_eq!(hits[0].hit.score, Some(9));
        // mirror: the second is the longer one
        let text = "beta alfa xxxxxxxxxxxx beta";
        let hits = run(&prox("alfa beta", 100), text);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].hit.char_start, 0);
        assert_eq!(hits[0].hit.score, Some(9));
    }

    #[test]
    fn overlapping_windows_of_equal_length_keep_the_earlier() {
        let text = "alfa beta alfa beta";
        let hits = run(&prox("alfa beta", 100), text);
        assert_eq!(starts(&hits), vec![0, 10]);
        let text = "alfa beta alfa";
        let hits = run(&prox("alfa beta", 100), text);
        assert_eq!(starts(&hits), vec![0], "tie: the earlier window wins");
    }

    #[test]
    fn windows_do_not_overlap_each_other_in_the_output() {
        let text = "alfa beta gama alfa beta gama alfa beta gama alfa";
        let hits = run(&prox("alfa beta gama", 100), text);
        let mut last_end = 0u32;
        for h in &hits {
            assert!(h.hit.char_start >= last_end, "{hits:?}");
            last_end = h.hit.char_start + h.hit.char_len;
        }
        assert!(hits.len() >= 3);
    }

    #[test]
    fn an_excluded_term_inside_the_window_drops_it() {
        assert_eq!(
            run(&prox("alfa beta -gama", 100), "alfa x beta y gama").len(),
            1
        );
        assert!(run(&prox("alfa beta -gama", 100), "alfa gama beta").is_empty());
        assert!(run(&prox("alfa beta -gama", 100), "alfa x gama x beta").is_empty());
        // outside the window on either side: kept
        let hits = run(&prox("alfa beta -gama", 100), "gama alfa x beta");
        assert_eq!(hits.len(), 1);
        // a second, clean pair survives while the polluted one is dropped
        let text = "alfa gama beta ........ alfa beta";
        let hits = run(&prox("alfa beta -gama", 30), text);
        assert_eq!(starts(&hits), vec![pos(text, "alfa beta")]);
    }

    #[test]
    fn an_excluded_phrase_and_whole_word_and_case_apply() {
        assert!(run(&prox("alfa beta -\"x y\"", 100), "alfa x y beta").is_empty());
        assert_eq!(
            run(&prox("alfa beta -\"x y\"", 100), "alfa x z y beta").len(),
            1
        );
        let mut q = prox("alfa beta -gama", 100);
        q.whole_word = true;
        assert_eq!(
            run(&q, "alfa gamas beta").len(),
            1,
            "gamas is not the word gama"
        );
        let mut q = prox("alfa beta -Gama", 100);
        q.case_sensitive = true;
        assert_eq!(run(&q, "alfa gama beta").len(), 1);
        assert!(run(&q, "alfa Gama beta").is_empty());
    }

    #[test]
    fn a_quoted_phrase_is_one_term() {
        let text = "fazer cessar x acordo";
        let hits = run(&prox("\"fazer cessar\" acordo", 100), text);
        assert_eq!(hits.len(), 1);
        let terms = &hits[0].hit.context.terms;
        assert_eq!(terms.len(), 2);
        assert_eq!((terms[0].start, terms[0].len, terms[0].term), (0, 12, 0));
        assert_eq!((terms[1].start, terms[1].len, terms[1].term), (15, 6, 1));
        // the words in the other order are not the phrase
        assert!(run(&prox("\"cessar fazer\" acordo", 100), text).is_empty());
        // unquoted they are two terms and match in any order
        assert_eq!(run(&prox("cessar fazer acordo", 100), text).len(), 1);
    }

    #[test]
    fn proximity_hits_carry_term_rects_window_rects_and_context() {
        let text = "antes alfa x y beta depois";
        let h = &run(&prox("alfa beta", 100), text)[0].hit;
        assert_eq!(h.char_start, pos(text, "alfa"));
        assert_eq!(h.char_len, 13);
        assert_eq!(h.score, Some(13));
        assert_eq!(h.rects.len(), 2);
        assert_eq!((h.rects[0].term, h.rects[1].term), (0, 1));
        assert_eq!(h.window_rects.len(), 1);
        let w = &h.window_rects[0].rect;
        assert!((w.x - (36.0 + 6.0 * 6.0)).abs() < 0.05);
        assert!((w.width - (12.0 * 6.0 + 5.0)).abs() < 0.05);
        assert_eq!(h.context.before, "antes ");
        assert_eq!(h.context.matched, "alfa x y beta");
        assert_eq!(h.context.after, " depois");
        assert!(h.spans_pages.is_none());
    }

    #[test]
    fn every_term_occurrence_inside_the_window_is_highlighted() {
        let text = "alfa beta alfa";
        let h = &run(&prox("alfa beta", 100), text)[0].hit;
        // minimal window is the first alfa..beta; the 2nd alfa is outside it
        assert_eq!(h.rects.len(), 2);
        let text = "alfa gama gama gama";
        let hits = run(&prox("alfa gama", 100), text);
        assert_eq!(
            hits[0].hit.rects.len(),
            2,
            "alfa + the nearest gama (minimal window)"
        );
        // a repeated term inside the window is highlighted each time
        let text = "alfa beta x beta gama";
        let h = &run(&prox("alfa gama beta", 100), text)[0].hit;
        let terms: Vec<u8> = h.rects.iter().map(|r| r.term).collect();
        assert_eq!(terms, vec![0, 2, 2, 1], "both betas are inside the window");
        let colored: Vec<u8> = h.context.terms.iter().map(|t| t.term).collect();
        assert_eq!(colored, vec![0, 2, 2, 1]);
    }

    #[test]
    fn a_window_across_lines_has_a_rect_per_line() {
        let text = "alfa x\ny z\nbeta";
        let h = &run(&prox("alfa beta", 100), text)[0].hit;
        assert_eq!(h.window_rects.len(), 3);
        assert_eq!(h.rects.len(), 2);
        assert_eq!(h.context.matched, "alfa x y z beta");
    }

    #[test]
    fn proximity_term_offsets_are_utf16_over_accented_text() {
        let text = "ação 😀 beta";
        let h = &run(&prox("acao beta", 100), text)[0].hit;
        assert_eq!(h.context.matched, "ação 😀 beta");
        let t = &h.context.terms;
        assert_eq!((t[0].start, t[0].len, t[0].term), (0, 4, 0));
        // "ação " = 5 units, 😀 = 2, " " = 1
        assert_eq!((t[1].start, t[1].len, t[1].term), (8, 4, 1));
        let units: Vec<u16> = h.context.matched.encode_utf16().collect();
        assert_eq!(String::from_utf16(&units[8..12]).unwrap(), "beta");
    }

    #[test]
    fn a_long_window_is_elided_and_keeps_the_end_terms() {
        let text = format!("alfa {} beta", "x ".repeat(90));
        let h = &run(&prox("alfa beta", 1000), &text)[0].hit;
        let m: Vec<char> = h.context.matched.chars().collect();
        assert_eq!(m.len(), ELIDE_KEEP * 2 + 3);
        assert_eq!(&m[ELIDE_KEEP..ELIDE_KEEP + 3], &[' ', '…', ' ']);
        let t = &h.context.terms;
        assert_eq!(t.len(), 2);
        assert_eq!((t[0].start, t[0].len, t[0].term), (0, 4, 0));
        let end = h.context.matched.encode_utf16().count() as u32;
        assert_eq!((t[1].start, t[1].len, t[1].term), (end - 4, 4, 1));
        // the score is the real window, not the elided text:
        // "alfa " + 90 × "x " (the last space is the separator) + "beta"
        assert_eq!(h.score, Some(5 + 180 + 4));
    }

    #[test]
    fn a_term_in_the_elided_middle_is_dropped_from_the_list() {
        let text = format!("alfa {} gama {} beta", "x ".repeat(50), "y ".repeat(50));
        let h = &run(&prox("alfa gama beta", 1000), &text)[0].hit;
        let terms: Vec<u8> = h.context.terms.iter().map(|t| t.term).collect();
        assert_eq!(terms, vec![0, 2]);
    }

    #[test]
    fn a_window_may_start_on_a_page_and_end_on_the_next() {
        let pages: Vec<Page> = vec![
            (3, "corpo\nfim alfa", vec![]),
            (4, "beta inicio\noutro", vec![]),
        ];
        let hits = run_pages(&prox("alfa beta", 100), &pages);
        assert_eq!(hits.len(), 1);
        let h = &hits[0];
        assert_eq!(h.page, 3);
        assert_eq!(h.hit.spans_pages, Some((3, 4)));
        assert_eq!(h.hit.score, Some(9), "the page break counts as one space");
        assert_eq!(h.hit.char_start, pos("corpo\nfim alfa", "alfa"));
        assert_eq!(h.hit.char_len, 4, "stops at the start page's end");
        let rect_pages: Vec<u32> = h.hit.rects.iter().map(|r| r.page).collect();
        assert_eq!(rect_pages, vec![3, 4]);
        let window_pages: Vec<u32> = h.hit.window_rects.iter().map(|r| r.page).collect();
        assert_eq!(window_pages, vec![3, 4]);
        assert_eq!(h.hit.context.matched, "alfa beta");
        assert_eq!(h.hit.context.before, "corpo fim ");
        assert_eq!(h.hit.context.after, " inicio outro");
    }

    #[test]
    fn page_furniture_does_not_count_toward_the_window_when_excluded() {
        let p0 = "corpo alfa\nPAGINA 1";
        let p1 = "CABECA\nbeta fim";
        let with = vec![
            (0, p0, vec![span(p0, "PAGINA 1")]),
            (1, p1, vec![span(p1, "CABECA")]),
        ];
        let hits = run_pages(&prox("alfa beta", 100), &with);
        assert_eq!(scores(&hits), vec![9]);
        assert_eq!(hits[0].hit.context.matched, "alfa beta");
        let without: Vec<Page> = vec![(0, p0, vec![]), (1, p1, vec![])];
        let hits = run_pages(&prox("alfa beta", 100), &without);
        assert_eq!(
            scores(&hits),
            vec!["alfa PAGINA 1 CABECA beta".len() as u32]
        );
        // and the same text is too long for a tight window unless excluded
        assert_eq!(run_pages(&prox("alfa beta", 20), &with).len(), 1);
        assert_eq!(run_pages(&prox("alfa beta", 20), &without).len(), 0);
    }

    #[test]
    fn a_window_never_spans_more_than_two_pages() {
        // decoy-like: terms on pages 0 and 2 with a short page 1 between them
        let pages: Vec<Page> = vec![(0, "alfa", vec![]), (1, "x", vec![]), (2, "beta", vec![])];
        assert!(run_pages(&prox("alfa beta", 5000), &pages).is_empty());
        let pages: Vec<Page> = vec![(0, "alfa", vec![]), (1, "beta", vec![])];
        assert_eq!(run_pages(&prox("alfa beta", 20), &pages).len(), 1);
        // three terms over three pages: no
        let pages: Vec<Page> = vec![
            (0, "alfa", vec![]),
            (1, "beta", vec![]),
            (2, "gama", vec![]),
        ];
        assert!(run_pages(&prox("alfa beta gama", 5000), &pages).is_empty());
        // but beta+gama on pages 1-2 is fine
        assert_eq!(run_pages(&prox("beta gama", 5000), &pages).len(), 1);
    }

    #[test]
    fn a_gap_in_the_pushed_pages_stops_a_window() {
        let pages: Vec<Page> = vec![(0, "alfa", vec![]), (2, "beta", vec![])];
        assert!(run_pages(&prox("alfa beta", 5000), &pages).is_empty());
        let pages: Vec<Page> = vec![
            (0, "alfa", vec![]),
            (1, "beta", vec![]),
            (3, "alfa", vec![]),
            (4, "beta", vec![]),
        ];
        let hits = run_pages(&prox("alfa beta", 100), &pages);
        assert_eq!(hits.iter().map(|h| h.page).collect::<Vec<_>>(), vec![0, 3]);
    }

    #[test]
    fn cross_page_windows_are_reported_in_order_with_overlap_resolution() {
        // windows: (alfa@p0, beta@p1); (beta@p1, alfa@p1) ties with it; (alfa@p1, beta@p1)
        let pages: Vec<Page> = vec![(0, "x alfa", vec![]), (1, "beta alfa y beta", vec![])];
        let hits = run_pages(&prox("alfa beta", 100), &pages);
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert_eq!((hits[0].page, hits[0].hit.spans_pages), (0, Some((0, 1))));
        assert_eq!((hits[1].page, hits[1].hit.spans_pages), (1, None));
        assert_eq!(hits[1].hit.score, Some("alfa y beta".len() as u32));
    }

    #[test]
    fn a_held_window_that_is_nested_in_the_next_pages_window_is_dropped() {
        // (alfa@p0, beta@p1) contains (alfa@p1, beta@p1): not minimal.
        let pages: Vec<Page> = vec![(0, "x alfa", vec![]), (1, "alfa beta", vec![])];
        let hits = run_pages(&prox("alfa beta", 100), &pages);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].page, 1);
        assert_eq!(hits[0].hit.spans_pages, None);
    }

    #[test]
    fn an_excluded_term_on_the_next_page_drops_a_spanning_window() {
        let pages: Vec<Page> = vec![(0, "alfa", vec![]), (1, "gama beta", vec![])];
        assert!(run_pages(&prox("alfa beta -gama", 100), &pages).is_empty());
        let pages: Vec<Page> = vec![(0, "alfa", vec![]), (1, "beta gama", vec![])];
        assert_eq!(run_pages(&prox("alfa beta -gama", 100), &pages).len(), 1);
    }

    #[test]
    fn proximity_works_with_a_single_term() {
        let hits = run(&prox("alfa", 100), "alfa x alfa y alfa");
        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|h| h.hit.score == Some(4)));
        assert!(hits.iter().all(|h| h.hit.window_rects.len() == 1));
        // a term longer than the window can never fit
        assert!(run(
            &prox("abcdefghijklmnopqrstuvwxyz", 20),
            "abcdefghijklmnopqrstuvwxyz"
        )
        .is_empty());
    }

    #[test]
    fn proximity_hyphen_and_accent_variants() {
        let text = "o contra\u{2}to inclui um pré\u{2}aviso de rescisão";
        assert_eq!(run(&prox("contrato rescisao", 100), text).len(), 1);
        assert_eq!(run(&prox("pré-aviso contrato", 100), text).len(), 1);
        assert_eq!(run(&prox("préaviso contra-to", 100), text).len(), 1);
    }

    #[test]
    fn proximity_case_and_diacritics_strictness() {
        let text = "Ação e acao e beta";
        let mut q = prox("ação beta", 100);
        q.ignore_diacritics = false;
        q.case_sensitive = true;
        assert!(
            run(&q, text).is_empty(),
            "no lowercase accented 'ação' in the text"
        );
        q.text = "Ação beta".into();
        assert_eq!(run(&q, text).len(), 1);
        q.text = "acao beta".into();
        assert_eq!(run(&q, text).len(), 1);
        q.ignore_diacritics = true;
        q.case_sensitive = false;
        q.text = "ação beta".into();
        // folded: both "Ação" and "acao" qualify; minimal window is acao..beta
        assert_eq!(starts(&run(&q, text)), vec![pos(text, "acao")]);
    }

    #[test]
    fn proximity_whole_word() {
        let mut q = prox("alfa beta", 100);
        q.whole_word = true;
        assert!(run(&q, "alfas betas").is_empty());
        assert_eq!(run(&q, "alfas alfa x beta").len(), 1);
    }

    // --- rank / streaming ---------------------------------------------------------------------

    fn fake(page: u32, start: u32, score: Option<u32>) -> FoundHit {
        let mut f = run(&phrase("x"), "x")[0].clone();
        f.page = page;
        f.hit.char_start = start;
        f.hit.score = score;
        f
    }

    #[test]
    fn rank_sorts_by_score_then_position() {
        let mut hits = vec![
            fake(2, 5, Some(30)),
            fake(1, 9, Some(10)),
            fake(1, 3, Some(30)),
            fake(0, 7, Some(10)),
            fake(0, 1, None),
        ];
        rank(&mut hits);
        let order: Vec<(u32, u32)> = hits.iter().map(|h| (h.page, h.hit.char_start)).collect();
        assert_eq!(order, vec![(0, 7), (1, 9), (1, 3), (2, 5), (0, 1)]);
    }

    #[test]
    fn rank_is_position_order_for_phrase_hits() {
        let mut hits = vec![fake(3, 1, None), fake(0, 8, None), fake(0, 2, None)];
        rank(&mut hits);
        let order: Vec<(u32, u32)> = hits.iter().map(|h| (h.page, h.hit.char_start)).collect();
        assert_eq!(order, vec![(0, 2), (0, 8), (3, 1)]);
    }

    #[test]
    fn proximity_hits_stream_out_as_they_are_final() {
        let compiled = Arc::new(compile(&prox("alfa beta", 100)).unwrap());
        let mut m = Matcher::new(compiled);
        let mut total = 0;
        for p in 0..6u32 {
            total += m.push_page(index(p, "alfa beta x alfa beta"), &[]).len();
            assert!(
                total >= p as usize,
                "hits do not pile up: {total} after page {p}"
            );
        }
        total += m.finish().len();
        assert_eq!(total, 12);
        assert!(m.finish().is_empty());
    }

    #[test]
    fn a_matcher_can_be_reused_after_finish() {
        let compiled = Arc::new(compile(&phrase("alfa")).unwrap());
        let mut m = Matcher::new(compiled);
        assert_eq!(m.push_page(index(0, "alfa"), &[]).len(), 1);
        assert!(m.finish().is_empty());
        assert_eq!(m.push_page(index(1, "alfa"), &[]).len(), 1);
    }

    #[test]
    fn strict_queries_verify_across_a_line_end_hyphen() {
        let text = "um Contra\u{2}to e um pré\u{2}aviso";
        let mut q = phrase("Contrato");
        q.case_sensitive = true;
        assert_eq!(run(&q, text).len(), 1);
        q.text = "contrato".into();
        assert_eq!(run(&q, text).len(), 0);
        let mut q = phrase("pré-aviso");
        q.ignore_diacritics = false;
        assert_eq!(run(&q, text).len(), 1);
        q.text = "pre-aviso".into();
        assert_eq!(run(&q, text).len(), 0);
        q.text = "préaviso".into();
        assert_eq!(run(&q, text).len(), 1);
    }

    #[test]
    fn excluded_furniture_at_the_top_leaves_no_leading_space_in_the_context() {
        let text = "CABECALHO\nbody alfa";
        let pages: Vec<Page> = vec![(0, text, vec![span(text, "CABECALHO")])];
        let h = &run_pages(&phrase("alfa"), &pages)[0].hit;
        assert_eq!(h.context.before, "body ");
        let h = &run_pages(&phrase("body"), &pages)[0].hit;
        assert_eq!(h.context.before, "");
        assert_eq!(h.char_start, pos(text, "body"));
    }

    // --- cheap property tests against brute-force references -----------------------------------

    /// Tiny deterministic generator (no extra dependency).
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self, n: usize) -> usize {
            self.0 = self
                .0
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            ((self.0 >> 33) as usize) % n
        }
    }

    fn collapse_lower(s: &str) -> String {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    }

    #[test]
    fn phrase_hits_equal_a_naive_search_on_random_text() {
        let mut rng = Lcg(7);
        let alphabet = ['a', 'b', 'A', 'B', ' ', ' ', '\n'];
        let pattern_alphabet = ['a', 'b', ' '];
        let mut checked = 0;
        for _ in 0..400 {
            let text: String = (0..rng.next(70) + 1)
                .map(|_| alphabet[rng.next(alphabet.len())])
                .collect();
            let pattern: String = (0..rng.next(4) + 1)
                .map(|_| pattern_alphabet[rng.next(pattern_alphabet.len())])
                .collect();
            let want_pattern = collapse_lower(&pattern);
            if want_pattern.is_empty() {
                continue;
            }
            // naive: leftmost non-overlapping occurrences in the collapsed text
            let hay: Vec<char> = collapse_lower(&text).chars().collect();
            let pat: Vec<char> = want_pattern.chars().collect();
            let mut want = 0;
            let mut i = 0;
            while i + pat.len() <= hay.len() {
                if hay[i..i + pat.len()] == pat[..] {
                    want += 1;
                    i += pat.len();
                } else {
                    i += 1;
                }
            }
            let hits = run(&phrase(&pattern), &text);
            assert_eq!(hits.len(), want, "text {text:?} pattern {pattern:?}");
            for h in &hits {
                assert_eq!(
                    collapse_lower(&h.hit.context.matched),
                    want_pattern,
                    "text {text:?} pattern {pattern:?}"
                );
            }
            checked += want;
        }
        assert!(
            checked > 100,
            "the generator produced enough hits ({checked})"
        );
    }

    /// Brute force: every minimal window (no sub-window holds all terms), then the documented
    /// overlap rule (shorter wins, tie earlier). Positions are inclusive char indexes.
    fn naive_windows(text: &[char], terms: &[char], max_len: usize) -> Vec<(usize, usize)> {
        let holds_all =
            |l: usize, r: usize| terms.iter().all(|t| text[l..=r].iter().any(|c| c == t));
        let mut minimal = Vec::new();
        for (l, cl) in text.iter().enumerate() {
            if !terms.contains(cl) {
                continue;
            }
            for (r, cr) in text.iter().enumerate().skip(l) {
                if !terms.contains(cr) || !holds_all(l, r) {
                    continue;
                }
                let shrinks = r > l && (holds_all(l + 1, r) || holds_all(l, r - 1));
                if !shrinks && r - l < max_len {
                    minimal.push((l, r));
                }
            }
        }
        // Minimality is judged BEFORE the length filter in the engine; with the length filter
        // applied after, a too-long minimal window is dropped, never replaced.
        let mut kept: Vec<(usize, usize)> = Vec::new();
        for w in minimal {
            match kept.last().copied() {
                Some(last) if w.0 <= last.1 => {
                    if w.1 - w.0 < last.1 - last.0 {
                        *kept.last_mut().unwrap() = w;
                    }
                }
                _ => kept.push(w),
            }
        }
        kept
    }

    #[test]
    fn proximity_windows_equal_a_brute_force_reference_on_random_text() {
        let mut rng = Lcg(42);
        let letters = ['a', 'b', 'c', 'x', 'x', 'x'];
        let mut windows_seen = 0;
        let mut overlaps_resolved = 0;
        for case in 0..600 {
            // single spaces only, so a window's length is its char span
            let text: String = (0..rng.next(60) + 6)
                .map(|i| {
                    if i % 3 == 2 {
                        ' '
                    } else {
                        letters[rng.next(letters.len())]
                    }
                })
                .collect();
            let n_terms = 2 + rng.next(2);
            let terms: Vec<char> = ['a', 'b', 'c'][..n_terms].to_vec();
            let max_len = 20 + rng.next(8);
            let chars: Vec<char> = text.chars().collect();
            let want = naive_windows(&chars, &terms, max_len);
            let query: String = terms
                .iter()
                .map(|c| c.to_string())
                .collect::<Vec<_>>()
                .join(" ");
            let hits = run(&prox(&query, max_len as u32), &text);
            let got: Vec<(usize, usize)> = hits
                .iter()
                .map(|h| {
                    let s = h.hit.char_start as usize;
                    (s, s + h.hit.char_len as usize - 1)
                })
                .collect();
            assert_eq!(
                got, want,
                "case {case}: text {text:?} terms {terms:?} N={max_len}"
            );
            for h in &hits {
                assert_eq!(h.hit.score, Some(h.hit.char_len));
            }
            windows_seen += got.len();
            overlaps_resolved += (got.len() > 1) as usize;
        }
        assert!(windows_seen > 200, "{windows_seen}");
        assert!(overlaps_resolved > 20, "{overlaps_resolved}");
    }

    #[test]
    fn proximity_windows_across_a_page_split_equal_the_unsplit_text() {
        // Splitting a text at a space into two consecutive pages must give the same windows as
        // one page, up to the page break counting as one space (the same as the space it replaced).
        let mut rng = Lcg(99);
        let letters = ['a', 'b', 'x', 'x'];
        let mut crossing = 0;
        for case in 0..300 {
            let len = rng.next(50) + 12;
            let text: String = (0..len)
                .map(|i| {
                    if i % 3 == 2 {
                        ' '
                    } else {
                        letters[rng.next(letters.len())]
                    }
                })
                .collect();
            let chars: Vec<char> = text.chars().collect();
            let split = (0..chars.len())
                .filter(|&i| chars[i] == ' ')
                .nth(rng.next(3) + 1);
            let Some(split) = split else { continue };
            let (left, right) = (&text[..split], &text[split + 1..]);
            let whole = run(&prox("a b", 24), &text);
            let pages: Vec<Page> = vec![(0, left, vec![]), (1, right, vec![])];
            let parts = run_pages(&prox("a b", 24), &pages);
            let score = |hits: &[FoundHit]| -> Vec<u32> { scores(hits) };
            assert_eq!(
                score(&whole),
                score(&parts),
                "case {case}: {text:?} split at {split}"
            );
            crossing += parts.iter().filter(|h| h.hit.spans_pages.is_some()).count();
        }
        assert!(crossing > 10, "{crossing}");
    }
}
