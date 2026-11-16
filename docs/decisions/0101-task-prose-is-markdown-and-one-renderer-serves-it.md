---
status: accepted
date: 2026-11-11
superseded-by:
---

# A **Task**'s `body` is markdown, and `AgentMarkdown` is the one renderer for Task prose

A **Task**'s `body` rendered as `whitespace-pre-wrap` plain text while its **Task artifacts**
already rendered through `AgentMarkdown` — so the same dialog showed one field as a document and
the other as a blob, and a body citing `docs/roadmap/x.md` or a PR printed the path as inert
characters. We decided `body` is markdown and renders through the SAME `AgentMarkdown` the
artifacts use, so the modal has one prose renderer and links in a body are clickable.

**Why this is a decision and not a swap of one component for another:** nothing in the schema says
a `body` is markdown. `tasks.body` is a nullable `TEXT`, the New Task dialog writes a plain
`<textarea>` into it, and the model's `create_task` writes a sentence. So the field's type is
unchanged and its *meaning* changed by convention — a reader who inspects only `db.rs` will still
believe a body is a blurb. The visible cost lands immediately: markdown collapses a single newline
to a space, so a body typed as two short lines in the textarea becomes one wrapped sentence.

## Considered options

- **Keep `whitespace-pre-wrap` and linkify only** — rejected. A hand-written linkifier would be a
  SECOND URL policy beside `safeUrlTransform`, and ADR 0051's denylist (`javascript` / `data` /
  `vbscript` / `blob` / `filesystem`) is exactly the kind of boundary that rots when it is spelled
  twice. It also buys links at the cost of every other markdown construct a **Session** writes into
  a body — a `- [ ]` list, a table, a `**bold**` — which GFM (`remark-gfm`, already mounted) handles
  for free.
- **A second, lighter markdown component for bodies** — rejected for the same reason as the
  linkifier, plus one of its own: the component mapping in `AgentMarkdown` is the ZCode scale,
  already pinned assertion-by-assertion through the real `ReactMarkdown` by
  `AgentMarkdown.test.tsx`. A second renderer starts a second pin that can drift.
- **`remark-breaks`, to preserve the author's single newlines** — rejected, and this is the leg a
  future reader will want back. It is not installed, it would be this repo's first new markdown
  dependency, and it makes a **Task** body render differently from the transcript and from a
  **Task artifact** — three prose surfaces in one app, two of which honour markdown's newline rule
  and one that does not. A body that wants line breaks should use a list, which is what markdown is
  for. Re-open this only if collapsed bodies turn out to be common in practice rather than a
  hypothetical.

## Consequences

- **`body` is markdown on trust, with nothing enforcing it.** `title` goes through `clean_title`
  (whitespace collapsed, capped at 80, one matching quote pair stripped); `body` is stored verbatim
  and now carries a format rule no layer checks. Do not add validation for it — the point of a
  free-form body is that a **Session** can write anything into it — but do not describe the field as
  "a short blurb" in new prose either. It is a document that is usually short.
- **`taskBlock` is unaffected, and that is a boundary worth naming.** The `<task>` launch block
  sends the body to the model as element content, escaped only against `</task>`. The model receives
  markdown either way — it always did — so making the *human* surface agree with what the model was
  already being sent is the whole change. No prompt, no escaping rule, and no wire shape moves.
- **Relative links resolve against the board's own Space for free.** `App` mounts
  `SpaceCwdProvider` above its view ternary and `TasksBoard` receives the same `spaceCwd` the
  provider reads, so `OpenAnchor` resolves `docs/roadmap/x.md` against the Space whose board is
  showing. One consequence to expect rather than debug: a body link in a test that mounts the dialog
  without a `SpaceCwdProvider` refuses as `relative-without-cwd`, because `useSpaceCwd()` answers
  `null` and `classify` refuses to guess.
- **The `spec` chip and the `spec` row stay inert.** A markdown body can now link to a spec; the
  `specPath` field itself renders as a read-only row, not as a `FileChip`. Two surfaces for one path
  with two behaviours is the disagreement this repo's own defect log is made of, so if the chip ever
  becomes a link it replaces the row rather than joining it.


## Amendment (2026-11-16) — a Task title is NOT capped at 80

**The body above is left as written, because it records the decision as it was made. The first
Consequences bullet's parenthetical is false of the task path, and a reader who trusts it will look
for a cut that does not exist.**

**1. `require_title` passes `max_chars: None`.** The parenthetical — "`title` goes through
`clean_title` (whitespace collapsed, capped at 80, one matching quote pair stripped)" — describes the
session namer, not a card. `commands/tasks.rs::require_title` calls `crate::agent::clean_title(raw,
None)`, so a **Task** title keeps the shared cleaning chain (whitespace runs collapse, one matching
quote layer strips) and loses the cut. The 80-character bound is `TITLE_MAX_CHARS`, and it is pi
parity on a title a **MODEL** invented, where a rambling answer has to be bounded somewhere. A card's
title is the user's own sentence, and `tasks.title` (`NOT NULL`) has nowhere else to keep an overflow:
a body is written only when the draft had a second line, so a long single-line draft loses every
character past the cut permanently. That is the measured harm that motivated making the cut a
parameter rather than a second function — a real card stored as `What is the default action for
notifications, i want to be able to click a notif`, 80 chars, mid-word, `body` `NULL` (`9b9bbe7b`).
The behaviour is pinned by
`a_long_task_title_is_kept_whole_and_never_cut_at_the_session_namer_cap`, which asserts a 132-char
title comes back whole, and `an_uncapped_title_still_gets_the_shared_cleaning`, which pins that
lifting the cut did not quietly drop the two rules that are still shared.

**2. The bullet is only false of tasks.** The **session** path still passes
`Some(TITLE_MAX_CHARS)` and its titles are still capped at 80, so the parenthetical remains true
there. The cap lives at the call site precisely so that lifting it for tasks could never lift it for
session titles; nothing else in this ADR moves, and `body` is still markdown on trust with nothing
enforcing it.
