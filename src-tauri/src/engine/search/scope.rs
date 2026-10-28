//! Search scope resolution (S4), `agents/SEARCH-ORCHESTRATION.md` §2.1
//! "Âmbito". Pure Rust over the outline returned by `engine::outline`.
//!
//! FROZEN SIGNATURES (the pipeline calls exactly these): `resolve_scope`,
//! `deepest_item_for_page`.

use std::ops::RangeInclusive;

use crate::types::{CmdResult, OutlineItem, RubricaError, SearchScope};

/// The inclusive 0-based page range a scope covers. `INVALID_ARG` for an
/// empty document, an invalid page range or an unknown outline item id (or one
/// without a page).
pub fn resolve_scope(
    scope: &SearchScope,
    page_count: u32,
    outline: &[OutlineItem],
) -> CmdResult<RangeInclusive<u32>> {
    if page_count == 0 {
        return Err(RubricaError::invalid_arg("the document has no pages"));
    }
    match scope {
        SearchScope::All => Ok(0..=page_count - 1),
        SearchScope::Pages { from, to } => {
            if from > to || *to >= page_count {
                return Err(RubricaError::invalid_arg(format!(
                    "invalid page range {from}-{to} for a document of {page_count} pages"
                )));
            }
            Ok(*from..=*to)
        }
        SearchScope::Outline { item_id } => {
            let item = find_item(outline, item_id).ok_or_else(|| {
                RubricaError::invalid_arg(format!("unknown outline item \"{item_id}\""))
            })?;
            match (item.page, item.page_end) {
                (Some(page), Some(end)) if page <= end && page < page_count => {
                    Ok(page..=end.min(page_count - 1))
                }
                _ => Err(RubricaError::invalid_arg(format!(
                    "outline item \"{item_id}\" has no page range"
                ))),
            }
        }
    }
}

fn find_item<'a>(outline: &'a [OutlineItem], id: &str) -> Option<&'a OutlineItem> {
    for item in outline {
        if item.id == id {
            return Some(item);
        }
        if let Some(found) = find_item(&item.children, id) {
            return Some(found);
        }
    }
    None
}

/// Id of the deepest outline entry whose range contains `page` (the key the
/// result list groups by). `None` without an outline or outside every entry.
///
/// Siblings are tried in order and the first whose `[page, pageEnd]` contains
/// `page` wins; the search then descends into its children. Entries without a
/// page never match themselves, but their children are still searched (a
/// page-less parent does not hide paged children).
pub fn deepest_item_for_page(outline: &[OutlineItem], page: u32) -> Option<String> {
    for item in outline {
        if let (Some(start), Some(end)) = (item.page, item.page_end) {
            if page >= start && page <= end {
                return Some(
                    deepest_item_for_page(&item.children, page).unwrap_or_else(|| item.id.clone()),
                );
            }
        } else if let Some(id) = deepest_item_for_page(&item.children, page) {
            return Some(id);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::RubricaErrorCode;

    fn item(
        id: &str,
        page: Option<u32>,
        end: Option<u32>,
        children: Vec<OutlineItem>,
    ) -> OutlineItem {
        OutlineItem {
            id: id.into(),
            title: id.into(),
            page,
            page_end: end,
            depth: id.matches('.').count() as u32,
            children,
        }
    }

    fn sample() -> Vec<OutlineItem> {
        vec![
            item(
                "0",
                Some(1),
                Some(7),
                vec![
                    item("0.0", Some(1), Some(3), vec![]),
                    item("0.1", None, None, vec![]),
                    item(
                        "0.2",
                        Some(5),
                        Some(7),
                        vec![item("0.2.0", Some(6), Some(6), vec![])],
                    ),
                ],
            ),
            item("1", Some(9), Some(12), vec![]),
        ]
    }

    #[test]
    fn all_pages_and_empty_document() {
        assert_eq!(resolve_scope(&SearchScope::All, 5, &[]).unwrap(), 0..=4);
        let err = resolve_scope(&SearchScope::All, 0, &[]).unwrap_err();
        assert_eq!(err.code, RubricaErrorCode::InvalidArg);
    }

    #[test]
    fn pages_range_is_validated() {
        let p = |from, to| SearchScope::Pages { from, to };
        assert_eq!(resolve_scope(&p(2, 2), 5, &[]).unwrap(), 2..=2);
        assert_eq!(resolve_scope(&p(0, 4), 5, &[]).unwrap(), 0..=4);
        for (from, to) in [(3, 2), (0, 5), (5, 5)] {
            let err = resolve_scope(&p(from, to), 5, &[]).unwrap_err();
            assert_eq!(err.code, RubricaErrorCode::InvalidArg);
        }
    }

    #[test]
    fn outline_item_range_and_errors() {
        let outline = sample();
        let o = |id: &str| SearchScope::Outline { item_id: id.into() };
        assert_eq!(resolve_scope(&o("0"), 20, &outline).unwrap(), 1..=7);
        assert_eq!(resolve_scope(&o("0.2.0"), 20, &outline).unwrap(), 6..=6);
        for id in ["0.1", "9", "", "0.2.1"] {
            let err = resolve_scope(&o(id), 20, &outline).unwrap_err();
            assert_eq!(err.code, RubricaErrorCode::InvalidArg, "{id:?}");
        }
        // an entry past the end of the document is not a usable range
        let err = resolve_scope(&o("1"), 5, &outline).unwrap_err();
        assert_eq!(err.code, RubricaErrorCode::InvalidArg);
    }

    #[test]
    fn deepest_item_cases() {
        let outline = sample();
        let d = |p| deepest_item_for_page(&outline, p);
        assert_eq!(d(0), None); // before the first entry
        assert_eq!(d(1).as_deref(), Some("0.0"));
        assert_eq!(d(4).as_deref(), Some("0")); // between sub-entries
        assert_eq!(d(6).as_deref(), Some("0.2.0"));
        assert_eq!(d(7).as_deref(), Some("0.2"));
        assert_eq!(d(8), None); // between top-level entries
        assert_eq!(d(12).as_deref(), Some("1"));
        assert_eq!(d(13), None);
        assert_eq!(deepest_item_for_page(&[], 3), None);
    }

    #[test]
    fn pageless_parent_does_not_hide_children() {
        let outline = vec![item(
            "0",
            None,
            None,
            vec![item("0.0", Some(2), Some(4), vec![])],
        )];
        assert_eq!(deepest_item_for_page(&outline, 3).as_deref(), Some("0.0"));
        assert_eq!(deepest_item_for_page(&outline, 5), None);
    }
}
