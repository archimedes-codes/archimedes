//! The PRIMITIVES half of the session-naming pass (see `naming.rs`'s header):
//! pure functions over `&[ChatMessage]` / `&str` / `&Model` — what text feeds
//! the title prompt, how an ask selection is cleaned, how the answer is capped,
//! which thinking level the request asks for, and which model the
//! `sessionNamingModel` override names. No `Db`, no `SessionManager`, no async,
//! so each rule is testable on its own.
//!
//! A CHILD of `naming` (and so a grandchild of `session`): it needs none of
//! `session`'s private surface, and `naming.rs` reads back what it needs (the
//! excerpt cap) with a private import.

use crate::agent::diagnostics;
use crate::agent::harness::catalog::{Model, ModelCatalog};
use crate::agent::harness::compact::is_compaction_summary;
use crate::agent::harness::model_key::ModelKey;
use crate::agent::harness::provider::{ChatMessage, ChatRole, MessageContent};
use crate::agent::tools::ContentBlock;
use crate::text::cap_chars;

/// Per-side character cap on the conversation excerpt (pi: 500).
pub(crate) const EXCERPT_CAP: usize = 500;

/// The text of a transcript message: `MessageContent::Text` verbatim, and
/// `MessageContent::Blocks` → the `ContentBlock::Text` parts joined with `\n`
/// — the same "text blocks only" rule pi filters for (`b?.type === "text"
/// && typeof b.text === "string"`), so an image block is not a segment and
/// does not consume a `\n` of the join. NOT trimmed: the caller trims, so
/// verbatim-vs-joined is the only thing this function decides.
pub(crate) fn message_text(content: &MessageContent) -> String {
    match content {
        MessageContent::Text(t) => t.clone(),
        MessageContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|b| match b {
                ContentBlock::Text { text } => Some(text.as_str()),
                ContentBlock::Image { .. } => None,
            })
            .collect::<Vec<&str>>()
            .join("\n"),
    }
}

/// The first exchange: the first `User` message with non-empty text, then
/// the first `Assistant` message with non-empty text AFTER it. Each side is
/// `"<Role>: " + text`, trimmed and capped at `EXCERPT_CAP` CHARS. Other
/// roles (system / tool) are ignored, and an assistant message that precedes
/// any user message is ignored (pi requires `foundUser` before it will accept
/// an assistant line — a restored preamble cannot become the title's subject).
/// `None` when there is no user text at all; an assistant side is OPTIONAL
/// (a turn whose assistant output was all tool calls still names from the
/// user text — pi's `conversationText` is non-empty on the user line alone).
///
/// One deliberate improvement on pi: a BLANK message is not a candidate at
/// all. pi sets `foundUser` on a whitespace-only first message, skips every
/// later one, and then bails at its own `conversationText.trim()` guard — so
/// such a session is never named. Here the first NON-EMPTY user text wins.
pub(crate) fn first_exchange_text(messages: &[ChatMessage]) -> Option<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut found_user = false;
    let mut found_assistant = false;
    for m in messages {
        if is_compaction_summary(m) {
            continue;
        }
        // The role decides WHICH side this row can fill, so it is matched
        // first and the non-excerpt roles leave immediately.
        let label = match m.role {
            ChatRole::User if !found_user => "User",
            // `found_user` in the guard IS pi's ordering rule: an assistant
            // row before any user row is not the second half of an exchange.
            ChatRole::Assistant if found_user && !found_assistant => "Assistant",
            _ => continue,
        };
        let body = message_text(&m.content);
        let body = body.trim();
        if body.is_empty() {
            // Blank text does not fill this side, so the NEXT message of the
            // same role is still a candidate (pi's `texts.length > 0`).
            continue;
        }
        lines.push(format!("{label}: {}", cap_chars(body, EXCERPT_CAP)));
        if label == "User" {
            found_user = true;
        } else {
            found_assistant = true;
        }
        // Both sides found — pi's `if (foundUser && foundAssistant) break`, so
        // a long transcript is not walked to its end for two lines of text.
        if found_user && found_assistant {
            break;
        }
    }
    // The user line is the only mandatory side, so "no lines" is exactly "no
    // user text at all" (an assistant row is only ever pushed after one).
    (!lines.is_empty()).then(|| lines.join("\n"))
}

/// Caps for multi-turn exchange formatting.
pub(crate) const MULTI_TURN_PROMPT_CAP: usize = 400;
pub(crate) const MULTI_TURN_SELECTION_CAP: usize = 200;
pub(crate) const MULTI_TURN_ASSISTANT_CAP: usize = 400;
pub(crate) const MULTI_TURN_TOTAL_CAP: usize = 2500;

/// Count user interactions (prompts and answered ask selections).
pub(crate) fn count_user_interactions(messages: &[ChatMessage]) -> usize {
    let mut ask_tool_call_ids = std::collections::HashSet::new();
    let mut count = 0;

    for m in messages {
        if is_compaction_summary(m) {
            continue;
        }
        match m.role {
            ChatRole::Assistant => {
                if let Some(tool_calls) = &m.tool_calls {
                    for tc in tool_calls {
                        if tc.name == "ask" {
                            ask_tool_call_ids.insert(tc.id.clone());
                        }
                    }
                }
            }
            ChatRole::User if !message_text(&m.content).trim().is_empty() => {
                count += 1;
            }
            ChatRole::Tool => {
                if let Some(ref call_id) = m.tool_call_id {
                    if ask_tool_call_ids.contains(call_id) {
                        let text = message_text(&m.content);
                        if text.trim_start().starts_with("User answers:") {
                            count += 1;
                        }
                    }
                }
            }
            _ => {}
        }
    }

    count
}

/// Clean an ask tool selection text by extracting between `"User answers:\n"`
/// and `"\n\nAnswer context:"` (or end of string), trimmed.
pub(crate) fn clean_ask_selection(text: &str) -> String {
    let after_prefix = if let Some(idx) = text.find("User answers:\n") {
        &text[idx + "User answers:\n".len()..]
    } else if let Some(idx) = text.find("User answers:") {
        &text[idx + "User answers:".len()..]
    } else {
        text
    };
    let content = if let Some(idx) = after_prefix.find("\n\nAnswer context:") {
        &after_prefix[..idx]
    } else if let Some(idx) = after_prefix.find("\nAnswer context:") {
        &after_prefix[..idx]
    } else {
        after_prefix
    };
    content.trim().to_string()
}

/// Multi-turn conversation excerpt collecting up to `max_interactions`
/// interactions along with closing assistant responses.
pub(crate) fn multi_turn_exchange_text(
    messages: &[ChatMessage],
    max_interactions: usize,
) -> Option<String> {
    if max_interactions == 0 {
        return None;
    }
    let mut ask_tool_call_ids = std::collections::HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    let mut pending_assistant: Option<String> = None;
    let mut interactions_collected = 0;

    for m in messages {
        if is_compaction_summary(m) {
            continue;
        }
        match m.role {
            ChatRole::Assistant => {
                if let Some(tool_calls) = &m.tool_calls {
                    for tc in tool_calls {
                        if tc.name == "ask" {
                            ask_tool_call_ids.insert(tc.id.clone());
                        }
                    }
                }
                if interactions_collected > 0 {
                    let text = message_text(&m.content);
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        pending_assistant = Some(trimmed.to_string());
                    }
                }
            }
            ChatRole::User => {
                let text = message_text(&m.content);
                let trimmed = text.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if interactions_collected >= max_interactions {
                    break;
                }
                if let Some(asst) = pending_assistant.take() {
                    lines.push(format!(
                        "Assistant: {}",
                        cap_chars(&asst, MULTI_TURN_ASSISTANT_CAP)
                    ));
                }
                lines.push(format!(
                    "User: {}",
                    cap_chars(trimmed, MULTI_TURN_PROMPT_CAP)
                ));
                interactions_collected += 1;
            }
            ChatRole::Tool => {
                let is_ask_answer = if let Some(ref call_id) = m.tool_call_id {
                    if ask_tool_call_ids.contains(call_id) {
                        let text = message_text(&m.content);
                        text.trim_start().starts_with("User answers:")
                    } else {
                        false
                    }
                } else {
                    false
                };
                if is_ask_answer {
                    if interactions_collected >= max_interactions {
                        break;
                    }
                    if let Some(asst) = pending_assistant.take() {
                        lines.push(format!(
                            "Assistant: {}",
                            cap_chars(&asst, MULTI_TURN_ASSISTANT_CAP)
                        ));
                    }
                    let text = message_text(&m.content);
                    let cleaned = clean_ask_selection(&text);
                    lines.push(format!(
                        "User (selection): {}",
                        cap_chars(&cleaned, MULTI_TURN_SELECTION_CAP)
                    ));
                    interactions_collected += 1;
                }
            }
            _ => {}
        }
    }

    if let Some(asst) = pending_assistant.take() {
        lines.push(format!(
            "Assistant: {}",
            cap_chars(&asst, MULTI_TURN_ASSISTANT_CAP)
        ));
    }

    if lines.is_empty() {
        None
    } else {
        Some(cap_chars(&lines.join("\n"), MULTI_TURN_TOTAL_CAP))
    }
}

/// The title request's single user message, VERBATIM pi's copy: the wording
/// is what small models answer well, so it is data pinned by a test rather
/// than prose to re-word. The excerpt rides between the `<conversation>`
/// tags, on its own line, with no extra blank lines around it.
pub(crate) fn title_prompt(exchange: &str) -> String {
    [
        "Generate a concise title (3-8 words) for this conversation.",
        "The title should capture what the user is working on.",
        "Return only the title, nothing else.",
        "",
        "<conversation>",
        exchange,
        "</conversation>",
    ]
    .join("\n")
}

/// The log line for a configured level the model does not advertise (its own
/// function so the exact text is pinned by a test — the crate logs to stderr
/// with `eprintln!` and its tests have no stderr capture harness).
pub(crate) fn unrecognized_reasoning_log(raw: &str) -> String {
    format!("session-name: ignoring unrecognized reasoning {raw:?}")
}

/// The thinking level the title request asks for (decision 3). `None` (absent
/// / blank setting) → `None`: omit the key — `ModelOptions.reasoning_effort:
/// None` already means "no thinking" here, so pi's `minimal` default would
/// ADD cost. A configured value is matched case- and padding-insensitively
/// against `model.thinking_levels` and the MODEL'S OWN spelling is returned
/// (the provider's vocabulary, not the user's typo-corrected one).
///
/// A model that advertises NO levels yields `None` — the same rule
/// `remembered_thinking_level` applies (`agent/session/mod.rs`), NOT
/// `supports_thinking_level`'s soft-pass: an unverifiable level is never
/// sent, because `ModelOptions.reasoning_effort` is forwarded VERBATIM by
/// every adapter and an unknown level is provider-dependent (some read it as
/// MORE thinking, some reject the request — pi's `mapThinkingLevelToEffort`
/// `default:` arm silently buying maximum effort on a one-line title is the
/// canonical horror). An unrecognised value against a non-empty set logs and
/// returns `None`.
///
/// THE DELIBERATE DEVIATION from pi: pi validates against a FIXED list
/// (`minimal…max`, `off` excluded because there it is a fourth spelling of
/// "unset"). Here the vocabulary is the MODEL'S advertised `thinking_levels`,
/// which for this app's providers legitimately include `off` / `none` meaning
/// "no thinking" — an advertised `off` is forwarded, because the model says it
/// understands it.
pub(crate) fn resolve_naming_reasoning(model: &Model, configured: Option<&str>) -> Option<String> {
    // A blank setting is "unset", not "an invalid level": nothing to forward
    // and nothing to warn about (the same normalisation `load_settings`
    // applies to `sessionNamingModel`).
    let raw = configured.map(str::trim).filter(|s| !s.is_empty())?;
    if model.thinking_levels.is_empty() {
        // Unverifiable — NOT the soft-pass that waves it through.
        return None;
    }
    let needle = raw.to_lowercase();
    model
        .thinking_levels
        .iter()
        .find(|level| level.to_lowercase() == needle)
        .cloned()
        .or_else(|| {
            diagnostics::record(&unrecognized_reasoning_log(raw));
            None
        })
}

/// One pass of pi's `findMatch`: the key as a canonical `provider/id`, then
/// as a bare id (unique-match only), then — when the key carries a `:` — the
/// same two rungs on the part before the LAST `:`.
pub(crate) fn find_naming_match(catalog: &ModelCatalog, key: &str) -> Option<Model> {
    let needle = key.to_lowercase();
    // 1. The canonical composed key, IGNORE-CASE (`resolve_composed_model`
    //    matches with `==`, so a hand-edited `"TAMA/m1"` would silently miss;
    //    `ModelKey`'s `Display` is the catalog's one key rendering).
    if let Some(m) = catalog
        .all()
        .iter()
        .find(|m| ModelKey::from(*m).to_string().to_lowercase() == needle)
    {
        return Some(m.clone());
    }
    // 2. A bare id — resolved ONLY when exactly one model carries it (pi: a
    //    bare id must be unique across providers, or the naming request could
    //    land on a different provider's model than the user meant).
    let mut id_matches = catalog
        .all()
        .iter()
        .filter(|m| m.id.to_lowercase() == needle);
    let only = id_matches.next();
    if only.is_some() && id_matches.next().is_none() {
        return only.cloned();
    }
    // 3. Thinking-suffix tolerance: the level is the TRAILING segment (a model
    //    id may itself contain `:`, hence `rsplit_once`, and rung 1 already saw
    //    the whole key). The empty-prefix guard is pi's `if (prefix)`: without
    //    it a key like `":high"` would retry the whole catalog on `""`.
    if let Some((prefix, _level)) = key.rsplit_once(':') {
        if !prefix.is_empty() {
            return find_naming_match(catalog, prefix);
        }
    }
    None
}

/// Resolve the `sessionNamingModel` override, in pi's order: trim, then the
/// canonical `provider/id` ignore-case, then a bare id when UNIQUE across
/// providers, then the same two rungs with a trailing `:<level>` suffix
/// stripped. Anything else → `None`, and the caller falls back to the
/// session's own model (pi's `settingsModel ?? ctx.model`).
///
/// Deliberately NOT `resolve_composed_model` (its `==` match misses a
/// differently-cased key) and NOT pre-stripped with `ModelRef::parse` (it
/// returns `None` for a key without a `/`, so a bare `"m1:high"` — a legal
/// hand-edited override — would never resolve).
pub(crate) fn resolve_naming_model(catalog: &ModelCatalog, key: &str) -> Option<Model> {
    let key = key.trim();
    if key.is_empty() {
        // pi's `resolveModel` rejects blank BEFORE matching; a
        // `sessionNamingModel: "   "` means "no override".
        return None;
    }
    find_naming_match(catalog, key)
}
