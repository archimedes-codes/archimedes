//! Text cleaning shared by more than one layer (ADR-agnostic, like `types.rs`).
//!
//! `clean_title` was born in `agent/session/naming.rs` as the session namer's cleaner and its ONLY
//! outside caller was the Task board. When the title rule moved to storage — the one path both the
//! IPC command and the `TaskStore` seam pass through — `storage/db.rs` needed it, and
//! `storage → agent` is the one import edge this crate holds at zero (see `types.rs`: "which is
//! what keeps `storage` from importing `agent`", and commit `24b8e06a`, which created `config/`
//! and `types.rs` to fix exactly this inversion). So the cleaner lives at the crate root instead.
//!
//! LAYERING: this module is a LEAF — std only, no `agent` / `commands` / `storage` imports, in
//! either direction. It cleans text; it knows nothing about sessions, cards or the wire.

/// The first `n` CHARS of `s`. This module's ONLY cut on text, and now the
/// crate's SHARED one: `agent/session/naming.rs` caps the conversation excerpt
/// and the title with it and `commands/attention.rs` caps the text it hands to
/// the operating system. Deliberately not a byte slice: the text is whatever
/// the user typed or the model answered, and `&s[..n]` panics when `n` lands
/// inside a multi-byte code point (one two-byte `é` at position 499 of a
/// 500-char cap is enough).
pub(crate) fn cap_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Strip ONE layer of matching surrounding quotes (`"…"` / `'…'`). pi's
/// regex is `^(\"|')((?:(?!\1).)*)\1$`, which says three things this mirrors:
/// the same quote character closes it, the INSIDE holds no other copy of it
/// (`"a" and "b"` is an answer that quotes within itself, not a wrapped
/// title), and one layer only — a doubly-wrapped answer is left completely
/// alone rather than half-stripped.
pub(crate) fn strip_one_quote_layer(s: &str) -> &str {
    let first = match s.chars().next() {
        Some(c @ ('"' | '\'')) => c,
        _ => return s,
    };
    // `strip_prefix` / `strip_suffix` on a `char` are boundary-safe (no byte
    // indexing), and a lone quote character strips to nothing but fails the
    // suffix test, so it is left alone.
    let inner = match s
        .strip_prefix(first)
        .and_then(|rest| rest.strip_suffix(first))
    {
        Some(inner) => inner,
        None => return s,
    };
    if inner.contains(first) {
        s
    } else {
        inner
    }
}

/// Clean a title: whitespace runs → one space, trim, strip ONE layer of
/// matching surrounding quotes (`"…"` / `'…'`). `None` when nothing survives —
/// an empty title is a failure, not a write of `""` into a `NOT NULL` column.
///
/// `max_chars` is a PARAMETER because the two callers disagree about the cut and
/// agree about everything else:
///
///  - the session namer passes `Some(TITLE_MAX_CHARS)` — pi parity, and a title a
///    MODEL invented, where a rambling answer has to be bounded somewhere;
///  - `commands/tasks.rs::require_title` passes `None`. A **Task** title is the
///    user's own sentence, stored in `tasks.title` (`NOT NULL`) with nowhere else
///    to keep the remainder: a card whose draft was one long line loses every
///    character past the cut permanently. Measured on a real card — a 132-char
///    draft stored as 80, mid-word, `body` NULL.
///
/// A parameter rather than a second function: the alternative is two copies of
/// the collapse-and-strip chain, which is the second title implementation this
/// repo has repeatedly documented as the thing not to do (`require_title`'s own
/// doc named the reuse as its reason for existing). The disagreement is one
/// boolean's worth of behaviour, so it is one argument.
///
/// The trim happens BEFORE the quote strip because that is pi's chain order
/// (`replace(/\s+/g, " ").trim().replace(quoteRe).slice(0, 80)`); a quote
/// pair that wraps inner spaces therefore keeps them, exactly as pi does —
/// not worth a deviation that changes what a title looks like.
pub fn clean_title(raw: &str, max_chars: Option<usize>) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<&str>>().join(" ");
    let stripped = strip_one_quote_layer(&collapsed);
    let title = match max_chars {
        Some(n) => cap_chars(stripped, n),
        None => stripped.to_string(),
    };
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    // The cleaner's OWN tests. The two tests that pin the session namer's cap
    // POLICY (`TITLE_MAX_CHARS`'s value) stay in `agent/session/naming.rs`,
    // where the constant lives — one owner per rule, and this module must not
    // name a session-namer policy.
    use super::{cap_chars, clean_title};

    /// The cap the fixtures below pass, as a LITERAL. The session namer's
    /// `TITLE_MAX_CHARS` lives in the private `mod naming` of the private
    /// `mod session` and is deliberately NOT widened or re-exported to satisfy
    /// a test (the same rule `commands/tasks/tests/board.rs` records, where the
    /// `80` is spelled out for the same reason). These tests pin the CLEANER —
    /// the collapse-and-strip chain and the char-boundary cut — and every input
    /// here is far shorter than 80 chars, so the number decides nothing they
    /// assert. The constant's VALUE is pinned where it is declared.
    const TITLE_MAX_CHARS: usize = 80;

    // ── `clean_title` (how the answer is cleaned) ─────────────────────────

    #[test]
    fn whitespace_runs_collapse_and_the_ends_trim() {
        assert_eq!(
            clean_title("  Porting   the session namer \n", Some(TITLE_MAX_CHARS)),
            Some("Porting the session namer".to_string())
        );
    }

    #[test]
    fn one_layer_of_matching_surrounding_quotes_is_stripped() {
        // The models answer in quotes more often than not; pi strips exactly
        // one layer (`/^(\"|')((?:(?!\1).)*)\1$/`).
        assert_eq!(
            clean_title("\"Porting the session namer\"", Some(TITLE_MAX_CHARS)),
            Some("Porting the session namer".to_string())
        );
        assert_eq!(
            clean_title("'x'", Some(TITLE_MAX_CHARS)),
            Some("x".to_string())
        );
    }

    #[test]
    fn anything_that_is_not_one_wrapping_pair_is_left_alone() {
        // An unbalanced quote is content, and a title that merely CONTAINS
        // its own quote character is not a wrapped answer — pi's `(?!\1)`
        // refuses both, so a `"x"` inside the answer survives.
        assert_eq!(
            clean_title("\"unbalanced", Some(TITLE_MAX_CHARS)),
            Some("\"unbalanced".to_string())
        );
        assert_eq!(
            clean_title("\"a\" and \"b\"", Some(TITLE_MAX_CHARS)),
            Some("\"a\" and \"b\"".to_string())
        );
        // A single quote character is not a pair.
        assert_eq!(
            clean_title("\"", Some(TITLE_MAX_CHARS)),
            Some("\"".to_string())
        );
        // A doubly-wrapped answer loses NOTHING (one layer means one layer).
        assert_eq!(
            clean_title("\"\"x\"\"", Some(TITLE_MAX_CHARS)),
            Some("\"\"x\"\"".to_string())
        );
    }

    #[test]
    fn an_answer_with_nothing_left_is_not_a_title() {
        assert_eq!(clean_title("", Some(TITLE_MAX_CHARS)), None);
        assert_eq!(clean_title("   ", Some(TITLE_MAX_CHARS)), None);
        assert_eq!(clean_title("\n\t \n", Some(TITLE_MAX_CHARS)), None);
        // Stripping the quotes can empty the answer: no title, so the caller
        // counts a failure rather than writing `""` to `sessions.title`.
        assert_eq!(clean_title("\"\"", Some(TITLE_MAX_CHARS)), None);
    }

    // ── `cap_chars` (the shared char cut) ─────────────────────────────────

    #[test]
    fn the_char_cap_does_not_slice_a_byte_sequence() {
        // `cap_chars` is the module's ONLY cut on user-supplied text; it must
        // land on a char boundary however awkwardly they fall.
        assert_eq!(cap_chars("aé", 1), "a");
        assert_eq!(cap_chars("éa", 1), "é");
        assert_eq!(cap_chars("a😀b", 2), "a😀");
        assert_eq!(cap_chars("abc", 10), "abc");
    }
}
