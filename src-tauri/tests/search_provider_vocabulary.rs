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
//! Both parses read a COMMENT-STRIPPED copy of the source (`strip_block_comments`
//! below), because a `{/* … */}` block is invisible to the renderer while staying
//! byte-present for a text scan — see that function for the measured false
//! negative it removes.
//!
//! ## What is actually load-bearing here
//!
//! Not a length check. `select_item_values` iterates `match_indices` over the
//! `<SelectItem` tag, so the number of values it returns EQUALS the raw occurrence
//! count of that tag by construction — an assert joining the two can only fire
//! from an inner `panic!`, never from a dropped element, so it was removed. What
//! does keep the parses honest: the `unwrap_or_else` panics that NAME the offending
//! tag (an unclosed opening tag, a `value`-less `<SelectItem>`, an unterminated
//! `value="`), the two non-emptiness asserts that stop a vacuous set comparison,
//! the exactly-one-`<SelectContent>` assert, and the comment strip.
//!
//! # What this file does NOT pin
//!
//! `docs/features/keenable-search-known-gaps.md` §4 is the durable record of this
//! surface — the gap it recorded (the unpinned `<SelectItem>` menu) is CLOSED by
//! this file, and the same §4 lists the residue below, so the two agree.
//!
//! - **The configuration ROWS — this file is blind to them.**
//!   `WebSearchSection.tsx` renders `KeyedProviderRow provider="brave" | "tavily" |
//!   "perplexity" | "keenable"` plus `SearxngRow` and `DuckDuckGoRow`; no assertion
//!   here compares that set to `SEARCH_PROVIDERS`, and the only assertion touching
//!   it is the cheap whole-file containment one below, which a `SelectItem` alone
//!   already satisfies. Measured: deleting the whole `provider="keenable"` row, or
//!   pointing one row's `apiKey` at another provider's field, leaves THIS file
//!   green. That hole is closed on the TypeScript side, not here —
//!   `WebSearchSection.test.tsx`'s "renders exactly one configuration row per
//!   Search provider, each wired to its own field" case compares the rendered row
//!   set to the provider set and checks each row's id, its read binding and its
//!   write binding. §4 carries the four mutations that prove it bites.
//! - **The menu's labels and its `(not configured)` predicates** — a `<SelectItem
//!   value="keenable">` whose guard reads the wrong settings field is unpinned, by
//!   either side (measured: repointing that guard at `tavilyApiKey` leaves this pin
//!   `ok` and the frontend suite green).
//! - **Order within the menu** (the parse is a set comparison; display order is
//!   cosmetic). `AVAILABILITY_ORDER` vs `SEARCH_PROVIDERS` IS order-pinned, since
//!   there order is behaviour.
//! - **Anything the source text cannot show, even with comments stripped.**
//!   Stripping `{/* … */}` closes the false negative a commented-out element is to
//!   a text scan, and it is the whole of what this file can see through. It does
//!   not make this a renderer: a `value="keenable"` rewritten to
//!   `value={providerId}` is a parse panic (loud), but a `value={someExpr}` that
//!   evaluates to a real id, a `{cond && <SelectItem …>}` that renders only
//!   sometimes, or a `<SelectItem>` built by a map over a hoisted array all read
//!   here as what they textually are, not as what they render. A conditional
//!   render is out of reach and always was.
//! - Anything in the sibling TypeScript implementation — a different repo, reached
//!   by no `include_str!` here.

use fulcrum_harness::web::config::SEARCH_PROVIDERS;
use fulcrum_harness::web::providers::registry::AVAILABILITY_ORDER;

/// Remove every `/* … */` block comment from the source text BEFORE either parse
/// runs — including the `{/* … */}` form JSX uses for a commented-out element.
///
/// This is not cosmetic. A comment is invisible to the renderer and fully present
/// to a text scan, so a parse over the raw text reads a disabled element as an
/// enabled one — and "disable it but leave it here" is the realistic shape, with
/// `{/* … */}` in use across 54 `.tsx` files under `src/`. Measured before this
/// function existed: wrapping the `brave` `<SelectItem>` in `{/* … */}` left the
/// raw `<SelectItem` count at 7, the parse at the full seven-value set, this pin
/// `ok` and the frontend suite at 8 passed; `["auto", /* "brave", */ "tavily", …]`
/// did the same to the array parse. Both now fail, naming `["brave"]`.
///
/// Each span becomes ONE space, so stripping can never join two tokens and can
/// never change how a re-wrapped literal reads — both parses stay wrap-agnostic.
///
/// Three known edges, all loud rather than silent. An unterminated `/*` panics
/// here. A `/*` inside a string literal strips through to the next `*/` — measured
/// against this file, a `/*` injected into the SearXNG `placeholder` reaches the
/// end of the source without a `*/` and panics here, so it cannot quietly hand a
/// parse a shortened list. And a `/*` … `*/` pair that straddles the array or the
/// menu would remove real elements, which is exactly what the set comparisons and
/// the non-emptiness asserts are there to catch. Line comments are deliberately
/// NOT stripped: this file's `placeholder="http://…"` values contain `//`, and
/// stripping them would eat real string content.
fn strip_block_comments(source: &str) -> String {
    const OPEN: &str = "/*";
    const CLOSE: &str = "*/";

    let mut out = String::with_capacity(source.len());
    let mut rest = source;
    while let Some(at) = rest.find(OPEN) {
        let closed_at = rest[at..].find(CLOSE).unwrap_or_else(|| {
            panic!("a `{OPEN}` block comment in the parsed source is never closed by `{CLOSE}`")
        });
        out.push_str(&rest[..at]);
        out.push(' ');
        rest = &rest[at + closed_at + CLOSE.len()..];
    }
    out.push_str(rest);
    out
}

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

    // Both parses — and the cheap containment check — read the COMMENT-STRIPPED
    // text, so a `{/* … */}`-disabled element is as invisible to this pin as it is
    // to the renderer. See `strip_block_comments`.
    let source = strip_block_comments(FRONTEND);

    // Direction 1a, the cheap one: every crate id is named SOMEWHERE in the file.
    // Deliberately NOT load-bearing — see the non-vacuity note above and the
    // missing-row hole below it.
    for id in SEARCH_PROVIDERS {
        assert!(
            source.contains(&format!("\"{id}\"")),
            "the crate offers Search provider `{id}` but \
             `WebSearchSection.tsx` never names it — the Settings UI cannot select \
             or configure it"
        );
    }

    let options = closed_select_options(&source);

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
        source.matches("<SelectContent").count(),
        1,
        "this file's `<SelectItem>` values are pinned as the provider menu, which \
         is sound only while it holds exactly ONE `<SelectContent>` — a second \
         `Select` here would feed unrelated values into the comparison below."
    );

    let menu = select_item_values(&source);

    // The parse pinned before it is trusted, same as the array's. There is
    // deliberately NO assert here comparing `menu.len()` to the raw `<SelectItem`
    // occurrence count: `select_item_values` iterates `match_indices("<SelectItem")`,
    // so the two are equal BY CONSTRUCTION and the assert could only ever fire from
    // one of that function's own `panic!`s — measured, a `<SelectItem` → `<MenuItem`
    // rename failed at `!menu.is_empty()` below, not there. A tautology billed as a
    // guard is worse than no guard, so the honesty of this parse rests on things
    // that can actually fail: the panics inside the parse, which NAME the offending
    // tag, and the non-emptiness assert immediately below (measured 7 `<SelectItem>`
    // elements including one for `auto`, and 7 array elements).
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
