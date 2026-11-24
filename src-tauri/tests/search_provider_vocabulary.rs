//! The SEARCH PROVIDER vocabulary, pinned ACROSS the language boundary.
//!
//! Extracted from `tests/fulcrum_seams.rs` (whose subject is TYPE IDENTITY ACROSS
//! THE SEAM — `Db: FulcrumPersistence`, `WorkerManager: Dispatcher`, the moved wire
//! DTOs). This file's subject is different: one hand-maintained vocabulary that
//! lives in THREE sources — four literals — and had no pin joining them.
//!
//! The spellings:
//!
//! - the crate's `SEARCH_PROVIDERS` — the wire's valid set; an id outside it is
//!   refused by `resolve_provider_from` with `Unknown provider: {id}`
//!   (`web/providers/registry.rs:67`, `:78`) and is filtered to `"auto"` by
//!   `WebConfig::from_web_settings` (`web/config.rs:91`), pinned crate-side by
//!   `test_exec_web_search_with_unknown_provider` and
//!   `unknown_default_provider_falls_back_to_auto`;
//! - the crate's `AVAILABILITY_ORDER` — the auto-fallback order;
//! - the frontend's two lists in `src/components/settings/WebSearchSection.tsx`:
//!   the closed-select array passed to `closedSelectValue(…)` (which values the
//!   component will ACCEPT) and the `<SelectItem>` menu (which values the user can
//!   CLICK).
//!
//! The crate cannot pin the frontend copy (it has no idea a `.tsx` exists) and the
//! frontend cannot pin the crate without a release. A Rust integration test that
//! `include_str!`s the `.tsx` is the one place both are nameable, so the Rust→TS
//! half of that gap closes HERE.
//!
//! # Why the frontend copies are the dangerous ones
//!
//! `closedSelectValue(stored, options, fallback)` returns `fallback` for ANY
//! `stored` value `options` does not offer. So a `defaultProvider` naming a
//! provider the array lacks renders "auto" while the stored value STAYS — and the
//! row never writes it back. Silent, not an error. The gate was green at 5
//! providers and is green at 6; it would be green at 7 with the frontend still at
//! 6. And a value in the array with no matching `<SelectItem>` is storable and
//! renders, but the user cannot select or deselect it, because there is no entry
//! to click. This file is what removes both shapes.
//!
//! # Non-vacuity
//!
//! Every frontend list is PARSED out of the source, never re-listed here — a test
//! that hand-copied a list would be a second copy of the thing it is meant to
//! check, and it would go red for the wrong reason (the copy drifts first). Each
//! parse is guarded against reading nothing: the `closedSelectValue(` call site is
//! asserted to occur exactly once, and the `<SelectItem>` parse is bounded to one
//! opening tag at a time with the file asserted to hold exactly one
//! `<SelectContent>`, so a rename, a duplicate, a hoisted constant or a second
//! `Select` fails LOUDLY instead of quietly scanning nothing. Both parses are
//! wrap-agnostic (measured: a one-element-per-line reformat of the array parses
//! identically, and a `<SelectItem>` re-wrapped across lines with a second
//! attribute parses identically).
//!
//! # What this file does NOT pin
//!
//! `docs/features/keenable-search-known-gaps.md` §4 is the durable record of this
//! surface — the gap it recorded (the unpinned `<SelectItem>` menu) is CLOSED by
//! this file, and the same §4 lists the residue below, so the two agree.
//!
//! - **Whether a configuration ROW exists** for each provider. `WebSearchSection.tsx`
//!   renders `KeyedProviderRow provider="brave" | "tavily" | "perplexity" |
//!   "keenable"` plus `SearxngRow` and `DuckDuckGoRow`; the only assertion touching
//!   that is the cheap whole-file containment one below, which a `SelectItem` alone
//!   already satisfies. Delete the Keenable row and the user loses the API-key
//!   field while this file stays green.
//! - **The menu's labels and its `(not configured)` predicates** — a `<SelectItem
//!   value="keenable">` whose guard reads the wrong settings field is unpinned.
//! - **Order within the menu** (the parse is a set comparison; display order is
//!   cosmetic). `AVAILABILITY_ORDER` vs `SEARCH_PROVIDERS` IS order-pinned, since
//!   there order is behaviour.
//! - Anything in the sibling TypeScript implementation — a different repo, reached
//!   by no `include_str!` here.

use fulcrum_harness::web::config::SEARCH_PROVIDERS;
use fulcrum_harness::web::providers::registry::AVAILABILITY_ORDER;

/// Extract the string literal elements of the closed-select array — the `[ … ]`
/// that follows the single `closedSelectValue(` CALL in the frontend source.
/// Wrap-agnostic (prettier may put one element per line), quote-order based.
fn closed_select_options(source: &str) -> Vec<&str> {
    const CALL: &str = "closedSelectValue(";

    let sites: Vec<usize> = source.match_indices(CALL).map(|(i, _)| i).collect();
    assert_eq!(
        sites.len(),
        1,
        "`{CALL}` must be CALLED exactly once in this file — the import of it is \
         `closedSelectValue,` and does not match. {sites:?} call sites means the \
         parse below is reading the wrong place (or nothing)."
    );

    let after_call = &source[sites[0] + CALL.len()..];
    let open = after_call
        .find('[')
        .expect("`closedSelectValue(` is called with its options array literal");
    let between = &after_call[open + 1..];
    let close = between
        .find(']')
        .expect("the options array literal is closed on the same expression");

    // `"a", "b"` → split on `"` → ["", "a", ", ", "b", ""] → the quoted elements
    // are at the odd indices, which is `skip(1).step_by(2)`.
    between[..close].split('"').skip(1).step_by(2).collect()
}

/// Extract the `value="…"` of every `<SelectItem …>` element in the frontend
/// source — the menu the user can actually click.
///
/// Each element is parsed inside ITS OWN opening tag (`<SelectItem` up to the next
/// `>`), so an element missing a `value` cannot silently reach into its neighbour
/// and steal that one: it panics naming the tag instead. Wrap-agnostic — the tag
/// end is a `>` wherever prettier put the line breaks, and there is no `>` inside
/// an attribute list.
fn select_item_values(source: &str) -> Vec<&str> {
    const ITEM: &str = "<SelectItem";
    const VALUE: &str = "value=\"";

    source
        .match_indices(ITEM)
        .map(|(i, _)| {
            let after = &source[i..];
            let tag_end = after
                .find('>')
                .unwrap_or_else(|| panic!("a `{ITEM}` opening tag is never closed"));
            let tag = &after[..tag_end];
            let at = tag.find(VALUE).unwrap_or_else(|| {
                panic!("a `{ITEM}` has no `{VALUE}…` attribute — its opening tag is `{tag}`")
            });
            let value = &tag[at + VALUE.len()..];
            let end = value
                .find('"')
                .unwrap_or_else(|| panic!("a `{ITEM}` `value=` is not a closed string — `{tag}`"));
            &value[..end]
        })
        .collect()
}

/// The Search provider vocabulary is ONE list across four hand-maintained
/// spellings; this pins the two the crate owns to each other (in order), the
/// crate's list to the frontend's closed-select array (both directions), and that
/// array to the frontend's `<SelectItem>` menu (both directions).
#[test]
fn the_search_provider_vocabulary_agrees_across_the_crate_and_the_frontend() {
    // The crate's own two lists. Same ids, SAME ORDER: `AVAILABILITY_ORDER`
    // drives the auto-fallback walk (`registry.rs:82`, and the
    // `current_idx + 1..` next-provider step at `:169`), so an id added to
    // `SEARCH_PROVIDERS` and forgotten here is selectable but never reached by
    // auto-resolution. The crate carries no pin for this pair.
    assert_eq!(
        AVAILABILITY_ORDER,
        &SEARCH_PROVIDERS[..],
        "`AVAILABILITY_ORDER` must be `SEARCH_PROVIDERS`, in order — the fallback \
         walk and the wire's valid set are the same vocabulary"
    );

    // `include_str!` over the frontend source (the repo already lints source
    // text this way — `tests/error_wire_gate.rs` includes its own). Resolved
    // relative to THIS file — `../..` because `include_str!` resolves against
    // `src-tauri/tests/`, the same depth `tests/fulcrum_seams.rs` sits at, so the
    // extraction did NOT change this path — so a moved `.tsx` breaks the pin at
    // compile time rather than silently guarding nothing.
    const FRONTEND: &str = include_str!("../../src/components/settings/WebSearchSection.tsx");

    // Direction 1a, the cheap one: every crate id is named SOMEWHERE in the file.
    // Deliberately NOT load-bearing — see the non-vacuity note above and the
    // missing-row hole below it.
    for id in SEARCH_PROVIDERS {
        assert!(
            FRONTEND.contains(&format!("\"{id}\"")),
            "the crate offers Search provider `{id}` but \
             `WebSearchSection.tsx` never names it — the Settings UI cannot select \
             or configure it"
        );
    }

    let options = closed_select_options(FRONTEND);

    // The parse itself, pinned before it is trusted: a non-empty array whose
    // first element is the fallback. (An empty parse would make BOTH set
    // comparisons below pass vacuously for the unknown direction, so this is not
    // belt-and-braces, it is the load-bearing one.)
    assert!(
        options.len() > 1,
        "the parsed closed-select array is empty — the parse found `{}` elements, \
         so the two comparisons below would be vacuous",
        options.len()
    );
    assert_eq!(
        options.first().copied(),
        Some("auto"),
        "`closedSelectValue`'s fallback is the array's first element and is not a \
         provider id — got {options:?}"
    );

    // The array minus the `"auto"` fallback is the frontend's provider set.
    let offered: Vec<&str> = options[1..].to_vec();

    // Direction 1b, the one that actually bites: every crate id is OFFERED by the
    // select. A provider the crate has and the array lacks is storable, valid on
    // the wire, and renders as "auto" forever.
    let missing: Vec<&str> = SEARCH_PROVIDERS
        .iter()
        .copied()
        .filter(|id| !offered.contains(id))
        .collect();
    assert!(
        missing.is_empty(),
        "`SEARCH_PROVIDERS` offers {SEARCH_PROVIDERS:?} but the closed-select array \
         in `WebSearchSection.tsx` is {offered:?} — a stored `defaultProvider` \
         naming a provider the array omits renders \"auto\" and never writes back \
         (closedSelectValue's fallback), with every test passing: {missing:?}"
    );

    // Direction 2, the other way: the array offers NOTHING the crate lacks. An
    // id here is a select item that `resolve_provider_from` answers with
    // `Unknown provider: {id}` (`registry.rs:67`, `:78`) and that
    // `WebConfig::from_web_settings` filters to "auto" (`config.rs:91`).
    let unknown: Vec<&str> = offered
        .iter()
        .copied()
        .filter(|id| !SEARCH_PROVIDERS.contains(id))
        .collect();
    assert!(
        unknown.is_empty(),
        "`WebSearchSection.tsx`'s closed-select array offers {offered:?}, which the \
         crate's `SEARCH_PROVIDERS` {SEARCH_PROVIDERS:?} does not: {unknown:?}"
    );

    // ── and the menu: `<SelectItem>` values == the closed-select array ─────────
    //
    // These are TWO literals in the same file. The array is what
    // `closedSelectValue` accepts; the menu is what the user can click. They agree
    // by hand, and until this block nothing checked that they kept agreeing. Both
    // directions fail with a user-visible consequence, so neither is cosmetic:
    //
    //   in the array, no `<SelectItem>` → the value is accepted and renders, but
    //   there is no entry to click, so it cannot be selected or deselected;
    //   in the menu, not in the array → the click writes a `defaultProvider` that
    //   `closedSelectValue` answers with its `"auto"` fallback, so the row
    //   re-renders as "auto" while the wire still accepts the stored value.
    //
    // `docs/features/keenable-search-known-gaps.md` §4 recorded this as an open
    // gap and measured both live mutations passing every test in the repo; this
    // block is that §4 closed.
    assert_eq!(
        FRONTEND.matches("<SelectContent").count(),
        1,
        "this file's `<SelectItem>` values are pinned as the provider menu, which \
         is sound only while it holds exactly ONE `<SelectContent>` — a second \
         `Select` here would feed unrelated values into the comparison below."
    );

    let menu = select_item_values(FRONTEND);

    // The parse pinned before it is trusted, same as the array's: measured 7
    // `<SelectItem>` elements (including one for `auto`) and 7 array elements at
    // the time of writing. `menu.len()` is compared to the raw occurrence count
    // so a parse that dropped an element cannot pass the set comparisons below on
    // a short list.
    assert_eq!(
        menu.len(),
        FRONTEND.matches("<SelectItem").count(),
        "the `<SelectItem>` parse returned {} values but the file has {} \
         `<SelectItem` occurrences — the parse is dropping elements, which would \
         make the two comparisons below pass on an incomplete menu.",
        menu.len(),
        FRONTEND.matches("<SelectItem").count()
    );
    assert!(
        !menu.is_empty(),
        "the parsed `<SelectItem>` menu is empty — the parse read nothing, so the \
         two comparisons below would be vacuous"
    );
    assert_eq!(
        menu.first().copied(),
        Some("auto"),
        "`auto` is the menu's first entry and the array's first element; if the \
         parse is right and this fails, the menu's order changed — got {menu:?}"
    );
    let mut menu_sorted = menu.clone();
    menu_sorted.sort_unstable();
    menu_sorted.dedup();
    assert_eq!(
        menu_sorted.len(),
        menu.len(),
        "the menu lists a provider twice — {menu:?}"
    );

    // Direction 3: every value the array accepts is CLICKABLE.
    let unclickable: Vec<&str> = options
        .iter()
        .copied()
        .filter(|value| !menu.contains(value))
        .collect();
    assert!(
        unclickable.is_empty(),
        "`closedSelectValue`'s array is {options:?} but the `<SelectItem>` menu is \
         {menu:?} — {unclickable:?} is accepted by the component and renders, yet \
         has no menu entry to click, so the user cannot select or deselect it: \
         add the matching `<SelectItem>`."
    );

    // Direction 4: every value the menu offers is ACCEPTED by the component.
    let unrenderable: Vec<&str> = menu
        .iter()
        .copied()
        .filter(|value| !options.contains(value))
        .collect();
    assert!(
        unrenderable.is_empty(),
        "the `<SelectItem>` menu is {menu:?} but `closedSelectValue`'s array is \
         {options:?} — {unrenderable:?} is selectable, writes itself to \
         `defaultProvider`, and then renders as \"auto\" because the array omits \
         it (closedSelectValue's fallback), with `SEARCH_PROVIDERS` still \
         accepting it on the wire: add it to the array."
    );
}
