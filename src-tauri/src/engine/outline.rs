//! Document outline (bookmarks) — `doc_outline`, CONTRACTS v1.2.0 §3 (S4).
//! Runs on the PDFium thread (inside `with_session`).
//!
//! FROZEN SIGNATURE: `read_outline`.
//!
//! # How a bookmark's page is resolved
//!
//! PDFium's `FPDFBookmark_GetDest` already handles a direct `/Dest` (explicit
//! `[page /Fit ...]` arrays and named destinations, looked up in the catalog's
//! `/Dests` and name tree) and a `/A << /S /GoTo /D ... >>` action. On top of that:
//!
//! * a bookmark whose action is anything other than a same-document GoTo (remote
//!   GoToR, embedded GoToE, URI, Launch, unsupported) gets `page: None`: PDFium
//!   would otherwise resolve a GoToR's numeric `/D [3 /Fit]` to page 3 of the
//!   *current* document, which is wrong;
//! * a destination whose page object is not in the page tree (PDFium answers -1)
//!   or whose page index is `>= page_count` gets `page: None`;
//! * no destination at all gets `page: None`.
//!
//! # Protection against hostile outlines
//!
//! The tree is walked with the bookmark handle (PDFium's `PdfBookmark` hashes and
//! compares by raw handle) recorded in a visited set, so a `/Next` or `/First`
//! chain that loops back to an earlier bookmark ends the walk of that chain
//! instead of repeating forever. On top of that the walk is bounded by
//! [`MAX_ENTRIES`] (total) and [`MAX_DEPTH`]: children of an entry at depth
//! `MAX_DEPTH - 1` are dropped. Nothing here panics or recurses deeper than
//! `MAX_DEPTH`.

use std::collections::HashSet;

use pdfium_render::prelude::*;

use crate::types::{CmdResult, OutlineItem};

/// Maximum number of entries read from one document; the rest is ignored.
pub const MAX_ENTRIES: usize = 10_000;
/// Maximum nesting: entries live at depth `0..MAX_DEPTH`; deeper ones are dropped.
pub const MAX_DEPTH: u32 = 64;

/// The outline tree with `page_end` computed, protected against cycles and
/// absurd depth; entries without a resolvable page get `page: None`.
pub fn read_outline(document: &PdfDocument) -> CmdResult<Vec<OutlineItem>> {
    let page_count = u32::try_from(document.pages().len()).unwrap_or(0);
    let mut walk = Walk {
        page_count,
        visited: HashSet::new(),
        entries: 0,
    };
    let raw = walk.read_level(document.bookmarks().root(), 0);
    Ok(build_items(raw, page_count))
}

/// One bookmark as read from PDFium, before ids / `page_end` are assigned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RawEntry {
    pub title: String,
    pub page: Option<u32>,
    pub children: Vec<RawEntry>,
}

struct Walk<'a> {
    page_count: u32,
    visited: HashSet<PdfBookmark<'a>>,
    entries: usize,
}

impl<'a> Walk<'a> {
    /// Reads `first` and its `/Next` siblings (and, recursively, their children).
    fn read_level(&mut self, first: Option<PdfBookmark<'a>>, depth: u32) -> Vec<RawEntry> {
        let mut out = Vec::new();
        if depth >= MAX_DEPTH {
            return out;
        }
        let mut cursor = first;
        while let Some(bookmark) = cursor {
            if self.entries >= MAX_ENTRIES || !self.visited.insert(bookmark.clone()) {
                break;
            }
            self.entries += 1;
            let title = bookmark.title().unwrap_or_default().trim().to_string();
            let page = self.resolve_page(&bookmark);
            let children = self.read_level(bookmark.first_child(), depth + 1);
            out.push(RawEntry {
                title,
                page,
                children,
            });
            cursor = bookmark.next_sibling();
        }
        out
    }

    fn resolve_page(&self, bookmark: &PdfBookmark<'a>) -> Option<u32> {
        if let Some(action) = bookmark.action() {
            if action.action_type() != PdfActionType::GoToDestinationInSameDocument {
                return None;
            }
        }
        // `destination()` already follows a same-document GoTo action; if it
        // found nothing, ask the action itself before giving up.
        let index = match bookmark.destination() {
            Some(destination) => destination.page_index().ok(),
            None => bookmark.action().and_then(|action| {
                let local = action.as_local_destination_action()?;
                let destination = local.destination().ok()?;
                destination.page_index().ok()
            }),
        };
        let index = u32::try_from(index?).ok()?;
        (index < self.page_count).then_some(index)
    }
}

/// Assigns ids (`"2.0.3"`: child-index path) and `page_end`, in tree order.
pub(crate) fn build_items(raw: Vec<RawEntry>, page_count: u32) -> Vec<OutlineItem> {
    // Pre-order flattening: (depth, page) per entry.
    let mut flat: Vec<(u32, Option<u32>)> = Vec::new();
    fn flatten(entries: &[RawEntry], depth: u32, out: &mut Vec<(u32, Option<u32>)>) {
        for e in entries {
            out.push((depth, e.page));
            flatten(&e.children, depth + 1, out);
        }
    }
    flatten(&raw, 0, &mut flat);
    let page_ends = compute_page_ends(&flat, page_count);

    fn assemble(
        entries: Vec<RawEntry>,
        depth: u32,
        prefix: &str,
        cursor: &mut usize,
        page_ends: &[Option<u32>],
    ) -> Vec<OutlineItem> {
        entries
            .into_iter()
            .enumerate()
            .map(|(i, e)| {
                let id = if prefix.is_empty() {
                    i.to_string()
                } else {
                    format!("{prefix}.{i}")
                };
                let page_end = page_ends[*cursor];
                *cursor += 1;
                let children = assemble(e.children, depth + 1, &id, cursor, page_ends);
                OutlineItem {
                    id,
                    title: e.title,
                    page: e.page,
                    page_end,
                    depth,
                    children,
                }
            })
            .collect()
    }
    let mut cursor = 0;
    assemble(raw, 0, "", &mut cursor, &page_ends)
}

/// `page_end` for every entry of the pre-order list: the page before the next
/// entry (in order) with depth `<=` its own that has a page, else the last page
/// of the document; clamped to `>= page`; `None` when the entry has no page.
fn compute_page_ends(flat: &[(u32, Option<u32>)], page_count: u32) -> Vec<Option<u32>> {
    let last_page = page_count.saturating_sub(1);
    let mut ends = vec![None; flat.len()];
    // Walking backwards: for each depth, (position, page) of the nearest following
    // entry with a page at exactly that depth.
    let mut nearest: Vec<Option<(usize, u32)>> = vec![None; MAX_DEPTH as usize + 1];
    for idx in (0..flat.len()).rev() {
        let (depth, page) = flat[idx];
        let d = (depth as usize).min(MAX_DEPTH as usize);
        if let Some(page) = page {
            let next = nearest[..=d]
                .iter()
                .flatten()
                .min_by_key(|(pos, _)| *pos)
                .map(|(_, p)| *p);
            let end = next.map_or(last_page, |p| p.saturating_sub(1));
            ends[idx] = Some(end.max(page));
            nearest[d] = Some((idx, page));
        }
    }
    ends
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(title: &str, page: Option<u32>, children: Vec<RawEntry>) -> RawEntry {
        RawEntry {
            title: title.into(),
            page,
            children,
        }
    }

    #[test]
    fn ids_and_page_ends_follow_the_tree() {
        let raw = vec![
            e(
                "a",
                Some(1),
                vec![e("a0", Some(1), vec![]), e("a1", Some(4), vec![])],
            ),
            e("b", Some(8), vec![]),
        ];
        let items = build_items(raw, 10);
        assert_eq!(items[0].id, "0");
        assert_eq!(items[0].page_end, Some(7));
        assert_eq!(items[0].children[0].id, "0.0");
        assert_eq!(items[0].children[0].page_end, Some(3));
        assert_eq!(items[0].children[1].id, "0.1");
        assert_eq!(items[0].children[1].page_end, Some(7));
        assert_eq!(items[1].id, "1");
        assert_eq!(items[1].page_end, Some(9));
    }

    #[test]
    fn pageless_entries_do_not_end_ranges_and_get_no_range() {
        let raw = vec![
            e("a", Some(2), vec![]),
            e("no page", None, vec![]),
            e("c", Some(6), vec![]),
        ];
        let items = build_items(raw, 10);
        assert_eq!(items[0].page_end, Some(5));
        assert_eq!(items[1].page, None);
        assert_eq!(items[1].page_end, None);
        assert_eq!(items[2].page_end, Some(9));
    }

    #[test]
    fn page_end_is_clamped_to_page_when_next_entry_is_not_after() {
        let raw = vec![e("a", Some(5), vec![]), e("b", Some(5), vec![])];
        let items = build_items(raw, 10);
        assert_eq!(items[0].page_end, Some(5));
        let raw = vec![e("a", Some(5), vec![]), e("b", Some(2), vec![])];
        let items = build_items(raw, 10);
        assert_eq!(items[0].page_end, Some(5));
        let raw = vec![e("a", Some(0), vec![]), e("b", Some(0), vec![])];
        assert_eq!(build_items(raw, 3)[0].page_end, Some(0));
    }
}
