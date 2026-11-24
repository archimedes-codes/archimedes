import { describe, expect, it } from "vitest";
import {
  buildLaunchMessage,
  escapeAttr,
  headOfLaunch,
  taskBlock,
  type TaskLaunchDestination,
} from "./taskPrompt";
import type { TaskRow } from "./tauri";

/**
 * `taskPrompt` — the pure builder for the first USER message of a Session opened
 * *for* a Task card.
 *
 * THE CONTRACT, in the order the surfaces need it:
 *  1. the `<task>` block is well-formed and carries the card's real id / stage /
 *     title;
 *  2. it is INJECTION-SAFE, because a Task title is free text a harness tool can
 *     write;
 *  3. the block lands LAST, after whatever instruction and `$skill` token precedes
 *     it — `NewTaskDialog.test.tsx` pins the same ordering for the composer path,
 *     and both surfaces must agree or one of them silently seeds context ahead of
 *     the user's own words;
 *  4. the head is derived ENTIRELY from the destination `TaskLaunchDestination` the
 *     caller passes — its label supplies the sentence and its `onEnterSkill` supplies
 *     the token — so no surface re-spells a skill name or an instruction as a literal
 *     (issue #179 / ADR 0098 deleted the mode table that used to own both);
 *  5. the column's **extra prompt** (`stages.prompt_prefix`) goes FIRST, ahead of the
 *     instruction and the token, and it is on the EXPANDING side of the injection
 *     boundary the way the token is — see the last describe for why that asymmetry
 *     against the `<task>` block is a decision and not an oversight.
 *
 * WHY THESE ARE NOT component tests: every rule here is a rule about a STRING, and
 * a component test can only see a string by driving a whole chat surface (which is
 * what `NewTaskDialog.test.tsx` pays to do). Asserting it here instead means the
 * detail modal and the New Task modal are pinned against ONE implementation.
 */

/** An expander that changes nothing — for the cases that only care about ORDER. */
const identity = (t: string): string => t;

/** One destination Stage (issue #179: the Stage row owns the launch).
 *
 *  The defaults are the SEEDED `research` stage — one of the five entries of Rust's
 *  `DEFAULT_STAGES` (ADR 0107 dropped the sixth, a `discuss` Stage that no launch
 *  surface could satisfy) — because that is the destination the shipped launch path
 *  actually carries. A case that cares about a Skill-less or differently-named
 *  Stage overrides the field it is about, which keeps each assertion about ONE
 *  difference from the seeded shape. */
function destination(
  over: Partial<TaskLaunchDestination> = {},
): TaskLaunchDestination {
  return {
    slug: "research",
    label: "Research",
    onEnterSkill: "research",
    // `null` is what every column that predates the workflow-graph work holds, and
    // REQUIRED rather than optional for the `auto` reason (T3): an optional field
    // compiles against a fixture that never sets it and then silently contributes
    // nothing when a real `StageDto` arrives.
    promptPrefix: null,
    ...over,
  };
}

function task(overrides: Partial<TaskRow> = {}): TaskRow {
  return {
    id: "tsk_1a2b",
    spacePath: "/w/alpha",
    number: 3,
    title: "Wire up the board",
    body: "Cards need a detail modal.",
    specPath: null,
    stageSlug: "backlog",
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

describe("taskPrompt — the <task> block", () => {
  it("is an open, self-contained block whose tag carries id, stage and title", () => {
    const block = taskBlock(task());
    expect(block.startsWith("<task ")).toBe(true);
    expect(block.trimEnd().endsWith("</task>")).toBe(true);
    expect(block).toContain('id="tsk_1a2b"');
    expect(block).toContain('stage="backlog"');
    expect(block).toContain('title="Wire up the board"');
    // The title rides the ATTRIBUTE only; the element content is the body. The
    // old shape echoed the title as the first content line too, which made a
    // body-less card read as its title twice.
    expect(block.split("\n")[1]).toBe("Cards need a detail modal.");
    expect(block.match(/Wire up the board/g)).toHaveLength(1);
  });

  it("emits EXACTLY one closing tag even when the body contains one", () => {
    // The body is element CONTENT and not an attribute, so the only sequence that
    // matters is the one that could close the tag early and let the rest of the
    // line out of the block.
    const block = taskBlock(task({ body: "first </task> then </TASK> tail" }));
    expect(block.match(/<\/task>/g)).toHaveLength(1);
    expect(block).toContain("&lt;/task>");
    expect(block).toContain("tail");
  });

  it("does NOT repeat the title when the card has no body", () => {
    // `tasks.body` is NULLABLE, and this used to fall back to the TITLE, so a
    // one-line card reached the model with its sentence TWICE — once as the
    // attribute, once as element content — and both copies were the same truncated
    // 80 chars. The repetition read as two different fields agreeing, which is a
    // worse signal than an empty body: it implies there IS a body and it is this.
    // The title rides the attribute, so nothing is lost by leaving the element empty.
    const block = taskBlock(task({ body: null }));
    expect(block).toBe(
      '<task id="tsk_1a2b" stage="backlog" title="Wire up the board">\n</task>',
    );
    expect(block.match(/Wire up the board/g)).toHaveLength(1);
  });

  it("emits the body as element content when the card HAS one", () => {
    const block = taskBlock(task());
    expect(block).toContain("Cards need a detail modal.");
    // The title is an attribute only — it is not echoed as content even when a
    // body exists, so the two fields never blur into one repeated sentence.
    expect(block.match(/Wire up the board/g)).toHaveLength(1);
  });

  it("escapes every character that could break out of an attribute", () => {
    // A title of `x" onload="boom` would CLOSE the attribute and ADD one. Both the
    // quote and the angle brackets are reachable: `clean_title` strips only one
    // MATCHING SURROUNDING quote pair, so inner quotes survive into `TaskRow.title`.
    expect(escapeAttr('a"b')).toBe('a&quot;b');
    expect(escapeAttr("<script>")).toBe("&lt;script&gt;");
    expect(escapeAttr("a&b")).toBe("a&amp;b");
    // `&` goes FIRST: escaping it last would re-escape the entities the other
    // replacements just produced (`<` → `&lt;` → `&amp;lt;`).
    expect(escapeAttr("&<")).toBe("&amp;&lt;");
    const block = taskBlock(task({ title: 'x" onload="boom' }));
    // What matters is that the QUOTES are gone, because the quotes are what
    // terminate the attribute. The literal text ` onload=` surviving INSIDE a
    // quoted value is inert — an early version of this test asserted the substring
    // was absent, which asserted nothing about injection and would have passed for
    // an escape that dropped the word instead of escaping the quote.
    const tag = block.slice(0, block.indexOf(">") + 1);
    expect(tag).toContain('title="x&quot; onload=&quot;boom"');
    // EXACTLY the three delimiting quotes of `id`, `stage` and `title`, so nothing
    // in the title opened a fourth.
    expect((tag.match(/"/g) ?? []).length).toBe(6);
  });
});

describe("taskPrompt — the <artifacts> block (issue #180 D2)", () => {
  it("lists the card's artifact keys between the open tag and the body", () => {
    // The keys are `TaskCardView.artifactKeys` (D1's board payload) — NAME ONLY.
    // A `research` Session started from a card that has a `spec` artifact has
    // to be told the name, or the model cannot ask for it: the whole point of the
    // element is that the Session discovers the list rather than guessing it
    // (spec §5). Position matters as much as presence — BEFORE the body, so the
    // body's prose cannot push the list past the model's attention, and inside
    // the `<task>` element, so the list is scoped to the card it describes.
    const block = taskBlock(task(), ["spec", "research"]);
    expect(block.startsWith("<task ")).toBe(true);
    expect(block).toContain("<artifacts>spec, research</artifacts>");
    expect(block.indexOf("<artifacts>")).toBeLessThan(
      block.indexOf("Cards need a detail modal."),
    );
    expect(block.indexOf("<artifacts>")).toBeGreaterThan(block.indexOf(">"));
    expect(block.trimEnd().endsWith("</task>")).toBe(true);
    // One line, comma-separated: the keys are names a `get_artifact` call takes
    // verbatim, and a bulleted list would invite the model to quote the bullet.
    expect(block.split("\n")[1]).toBe("<artifacts>spec, research</artifacts>");
  });

  it("emits NO <artifacts> element at all when the card has none", () => {
    // THE ABSENCE PIN, and the reason this block waited for D2. An empty card
    // must not say `<artifacts></artifacts>`: that asserts "there is an artifact
    // list and it is empty", where the truth is "nobody has written one"
    // (spec §5). The two read differently to a model — the first invites a
    // "there is nothing to read" conclusion it was never entitled to draw, and
    // invites a write where the human simply has not written yet.
    //
    // Byte-identical to the pre-D2 shape is the mutation this case exists for:
    // an implementation that emits the empty element (or an empty line) reddens
    // here even though every other case in this file would still pass.
    expect(taskBlock(task(), [])).toBe(taskBlock(task()));
    expect(taskBlock(task(), [])).not.toContain("<artifacts");
    expect(taskBlock(task({ body: null }), [])).toBe(
      '<task id="tsk_1a2b" stage="backlog" title="Wire up the board">\n</task>',
    );
    // A body-less card WITH artifacts still gets the element — the artifact list
    // is not conditional on the card having prose.
    expect(taskBlock(task({ body: null }), ["spec"])).toBe(
      '<task id="tsk_1a2b" stage="backlog" title="Wire up the board">\n' +
        "<artifacts>spec</artifacts>\n</task>",
    );
  });

  it("escapes artifact keys like every other value that enters the block", () => {
    // The artifact-key grammar (`[a-z0-9][a-z0-9-]{0,39}`, ADR 0100) already
    // excludes everything tag-unsafe, so this is defence in depth and NOT the
    // load-bearing guard — but the key arrives from a `String` column through a
    // wire type, and every other value that enters this block is escaped
    // unconditionally. A key that somehow carried a `<` must not be the one field
    // that ends the element early.
    const block = taskBlock(task(), ['a"b', "c<d"]);
    expect(block).toContain("&quot;");
    expect(block).toContain("&lt;d");
    expect(block).not.toContain("<artifacts>a\"b");
    // The element still closes exactly once, which is what an escape protects.
    expect(block.match(/<\/artifacts>/g)).toHaveLength(1);
  });
});

describe("taskPrompt — the launch draft", () => {
  it("puts the skill token before the task block, never after", () => {
    // THE SURVIVING ORDERING PIN (issue #179 re-pin). `3ebab9e2` removed the older
    // form of this case, which compared `indexOf("<skill")` to `indexOf("<task ")`:
    // that asserted the INLINED shape, and inlining is exactly what was deleted,
    // because a `<task>` block trailing an appended `<skill>` block makes
    // `splitMentionBlocks` refuse to parse and the user's own bubble printed the
    // whole 18 KB SKILL.md as literal text. So the assertion is now about the
    // `$token` — the shipped mechanism — and it must NOT be widened back into a
    // `<skill>`-versus-`<task>` index comparison.
    //
    // The ordering still matters: the destination's token frames the request, it
    // does not follow it, and `NewTaskDialog.test.tsx` pins the same ordering for
    // the create surface so the two cannot drift.
    const message = buildLaunchMessage(
      task(),
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      identity,
    );
    expect(message).toContain("$research");
    expect(message.indexOf("$research")).toBeLessThan(message.indexOf("<task "));
    expect(message.trimEnd().endsWith("</task>")).toBe(true);
  });

  it("runs the expander over the HEAD ONLY, never over the task block", () => {
    // THE INJECTION PIN, and the reason `expand` is a parameter. A Task title is
    // free text — a harness tool, or a person typing `$deploy` into a card body,
    // can put a real Mention token inside it — and `expandMentions` expands every
    // token it finds with no idea what it is inside. If the finished message were
    // handed to the expander, a card titled `$some-skill` would inject a skill
    // block into a Session nobody asked for.
    //
    // The spy is the instrument: it records what the expander was ACTUALLY handed,
    // so a caller-side reordering that fed the whole message through cannot pass.
    const seen: string[] = [];
    buildLaunchMessage(
      task({ title: "$deploy", body: "$other-skill" }),
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      (t) => {
        seen.push(t);
        return t.toUpperCase();
      },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("<task");
    expect(seen[0]).not.toContain("$deploy");
    expect(seen[0]).not.toContain("$other-skill");
    expect(seen[0]).toContain("$research");
    // And the block rode through the expander untouched — the expander upper-cased
    // the head and NOTHING else, so the card's text is byte-identical below it.
    const message = buildLaunchMessage(
      task({ title: "$deploy" }),
      destination({ slug: "research", label: "Research", onEnterSkill: "research" }),
      (t) => t.toUpperCase(),
    );
    expect(message).toContain('title="$deploy"');
    expect(message.slice(0, message.indexOf("<task "))).toBe(
      seen[0].toUpperCase() + "\n\n",
    );
  });

  it("names the destination's skill as a $ token so the ONE expansion path handles it", () => {
    // There is deliberately no second skill-injection code path (the same rule
    // `NewTaskDialog`'s dropdown follows). A token is what `expandMentions` reads.
    //
    // A destination with NO Skill contributes no token at all: that is the state
    // every pre-#179 column is in, and a bare `$` would be an unmatched token
    // riding the text verbatim to the model.
    expect(headOfLaunch(destination({ slug: "research", onEnterSkill: "research" }))).toContain("$research");
    expect(headOfLaunch(destination({ slug: "research", onEnterSkill: "research" }))).not.toContain("$discuss");
    expect(headOfLaunch(destination({ slug: "approved", onEnterSkill: null }))).not.toContain("$");
  });

  it("carries an instruction line built from the destination's label", () => {
    // The Session has no user prose to send — the card IS the request — so without
    // this the message is two XML blocks and nothing that says what to do.
    //
    // The sentence is DERIVED from the Stage's label (spec §6.1), which is the
    // known rough edge the spec accepts: a Stage labelled `WIP` produces "Let's
    // work on WIP." — a 3-char noun doing sentence duty. It is pinned here with
    // exactly that label so the accepted shape is the one on record, and so a
    // revert to the deleted per-mode prose ("Research this task.") cannot pass.
    expect(headOfLaunch(destination({ slug: "doing", label: "WIP", onEnterSkill: null }))).toBe(
      "Let's work on WIP.",
    );
    expect(headOfLaunch(destination({ slug: "research", label: "Research", onEnterSkill: "research" }))).toBe(
      "Let's work on Research.\n\n$research",
    );
  });

  it("forwards the artifact keys into the block it appends", () => {
    // `buildLaunchMessage` is the ONLY thing the launch surfaces call, so the keys
    // have to ride through it — a `taskBlock` that supports keys while the launch
    // path never passes them is a feature that ships invisible. `store/taskLaunch`
    // resolves them from the same `boardsBySpace` slice the board renders, so this
    // is the seam between that store read and the model's prompt.
    const message = buildLaunchMessage(task(), destination(), identity, [
      "spec",
      "research",
    ]);
    expect(message).toContain("<artifacts>spec, research</artifacts>");
    // Still LAST: the keys join the block, they do not precede the instruction.
    expect(message.indexOf("<artifacts>")).toBeGreaterThan(
      message.indexOf("$research"),
    );
    // And the default (no argument) is the same string as before D2 — the fresh
    // draft card has no artifacts and must not gain an empty element.
    expect(buildLaunchMessage(task(), destination(), identity)).toBe(
      buildLaunchMessage(task(), destination(), identity, []),
    );
    expect(buildLaunchMessage(task(), destination(), identity)).not.toContain(
      "<artifacts",
    );
  });
});

describe("taskPrompt — the column's extra prompt (`stages.prompt_prefix`)", () => {
  /** The message a Skill-bearing, prefix-less column produces TODAY — written out as
   *  a literal rather than derived from the code under test, because every case below
   *  compares against it and a comparison to a computed value proves nothing about a
   *  shape that changed. Every existing column in every existing database holds
   *  `prompt_prefix` NULL, so THIS is the overwhelmingly common output and the one
   *  that must not wobble by one byte. */
  const PREFIXLESS_RESEARCH =
    "Let's work on Research.\n\n$research\n\n" +
    '<task id="tsk_1a2b" stage="backlog" title="Wire up the board">\n' +
    "Cards need a detail modal.\n</task>";

  it("sends the prefix FIRST, ahead of the instruction and the skill token", () => {
    // The settled design is "1 Skill per column, PLUS a per-column extra-prompt field
    // prepended **before the Skill launch**". So the order is prefix → instruction →
    // token → block, and the prefix is not merely PRESENT: a prefix that landed after
    // the `$research` token would be a column framing the Skill it is about to load
    // with text the Skill has already been asked to do, and a prefix that landed
    // inside the `<task>` block would be card-scoped rather than column-scoped.
    const message = buildLaunchMessage(
      task(),
      destination({ promptPrefix: "Read the attached board before you start." }),
      identity,
    );
    expect(message.indexOf("Read the attached board before you start.")).toBe(0);
    expect(message.indexOf("Read the attached board")).toBeLessThan(
      message.indexOf("Let's work on Research."),
    );
    expect(message.indexOf("Let's work on Research.")).toBeLessThan(
      message.indexOf("$research"),
    );
    expect(message.indexOf("$research")).toBeLessThan(message.indexOf("<task "));
    expect(message.trimEnd().endsWith("</task>")).toBe(true);
  });

  it("separates the prefix from the head with one blank line (the house `\\n\\n`)", () => {
    // The separator is pinned as a literal because the file already uses `\n\n`
    // between head and block: one shape for "these are the two parts of a launch
    // message", spelled the same way twice. A single newline or a blank-line-plus-
    // one here would be a visible difference in the user's own bubble for no reason.
    expect(
      buildLaunchMessage(
        task(),
        destination({ promptPrefix: "Frame it first." }),
        identity,
      ),
    ).toBe("Frame it first.\n\n" + PREFIXLESS_RESEARCH);
  });

  it("trims the prefix and adds nothing around it", () => {
    // The column stores what was typed, RAW (`StageRow`'s `<Input>` does not trim and
    // the Rust command does not trim), so a person who pressed Enter after their
    // sentence has a trailing `\n` in the cell. Un-trimmed that becomes three blank
    // lines in the message — the model has to explain the whitespace to itself, and
    // `taskBlock`'s own comment records the house rule that a blank line the model
    // must account for is worse than no line.
    expect(
      buildLaunchMessage(
        task(),
        destination({ promptPrefix: "\n  Frame it first.  \n\n" }),
        identity,
      ),
    ).toBe("Frame it first.\n\n" + PREFIXLESS_RESEARCH);
  });

  it("is BYTE-IDENTICAL to today for a column with no extra prompt", () => {
    // THE COMPATIBILITY PIN. `prompt_prefix` has no SQL `DEFAULT`, so every column
    // that predates this change reads back NULL, and the whole existing suite of
    // prompt pins — this file, `NewTaskDialog.test.tsx`, `taskLaunch.test.ts` — is
    // written against the prefix-less shape. An implementation that emitted an empty
    // line, an empty element, or a separator with nothing before it reddens here
    // while still passing every other case in this describe.
    const nullPrefix = buildLaunchMessage(task(), destination(), identity);
    expect(nullPrefix).toBe(PREFIXLESS_RESEARCH);
    // `""` is a VALUE a person typed and cleared the other way round (the Rust
    // `set_stage_prompt_prefix` answers `""` back as a value and keeps NULL as the
    // only clear), but it contributes NOTHING to a message either. Both spellings of
    // "nothing" must produce the same bytes as the column that never had one.
    expect(
      buildLaunchMessage(task(), destination({ promptPrefix: "" }), identity),
    ).toBe(PREFIXLESS_RESEARCH);
    // Whitespace-only is the third spelling — a cell someone typed into and then
    // backspaced over, leaving a space. It contributes nothing either, and it must
    // NOT become a leading blank line above the instruction.
    expect(
      buildLaunchMessage(task(), destination({ promptPrefix: "   \n\t " }), identity),
    ).toBe(PREFIXLESS_RESEARCH);
    // And the same holds for a Skill-LESS column, i.e. the other arm of `headOfLaunch`.
    const skillless = {
      slug: "review",
      label: "Review",
      onEnterSkill: null,
      promptPrefix: null,
    } satisfies TaskLaunchDestination;
    expect(buildLaunchMessage(task(), skillless, identity)).toBe(
      "Let's work on Review.\n\n" +
        '<task id="tsk_1a2b" stage="backlog" title="Wire up the board">\n' +
        "Cards need a detail modal.\n</task>",
    );
  });

  it("hands the prefix to `expand` and STILL never the task block", () => {
    // THE BOUNDARY PIN, and the one a future reader is most likely to "fix" by
    // accident. The prefix is INSIDE `expand`'s argument; the `<task>` block is
    // OUTSIDE it. Both halves are asserted here because either one alone can be
    // broken by a plausible-looking edit: moving the prefix after `expand(head)`
    // returns (a one-line change that keeps every other case green) would silently
    // stop a prefix that says `use $implement here` from working, and folding the
    // block into the expanded text would reopen the injection hole the case above
    // pins shut.
    const seen: string[] = [];
    buildLaunchMessage(
      task(),
      destination({ promptPrefix: "Use $implement when you get there." }),
      (text) => {
        seen.push(text);
        return text;
      },
    );
    expect(seen).toHaveLength(1);
    // The prefix is in there — and FIRST, which is what "prepended before the Skill
    // launch" means at this level of the stack.
    expect(seen[0]).toBe(
      "Use $implement when you get there.\n\nLet's work on Research.\n\n$research",
    );
    // The card is not.
    expect(seen[0]).not.toContain("<task");
    expect(seen[0]).not.toContain("Wire up the board");
  });

  it("expands a $ token in the prefix and never one in a card title", () => {
    // THE ASYMMETRY, spelled out as behaviour. Both are free text and both are
    // `string | null` on the wire, so nothing in the TYPES says which one expands —
    // and that is exactly why this case exists.
    //
    // The prefix is AUTHOR text: the same person who picks the column's Skill typed it,
    // in the Stage editor, as configuration. It expands for the same reason the
    // `$skill` token beside it expands — a column that says "use $implement here"
    // means it, and a column whose author can pick a Skill from a dropdown but cannot
    // NAME one in prose is the field this task exists to add.
    //
    // The `<task>` block is CARD text: a title is free text a harness tool can write,
    // so a card titled `$some-skill` must never be able to inject a skill block into
    // a Session nobody asked for. That is the security property `buildLaunchMessage`'s
    // doc comment records, and it is unchanged by this task.
    //
    // The fake expander stands in for `expandMentions` by rewriting every `$token` it
    // is handed, so the assertion is about WHICH TEXT was handed to it.
    const expandTokens = (text: string): string =>
      text.replace(/\$([a-z-]+)/g, "<expanded:$1>");

    const withPrefix = buildLaunchMessage(
      task(),
      destination({ promptPrefix: "Use $implement when you get there." }),
      expandTokens,
    );
    expect(withPrefix).toContain("<expanded:implement>");
    expect(withPrefix).toContain("<expanded:research>");

    // A title carrying the same token is untouched — same expander, same call, and
    // the difference is only which side of the boundary the text came from.
    const titled = buildLaunchMessage(
      task({ title: "$implement" }),
      destination(),
      expandTokens,
    );
    expect(titled).toContain("<expanded:research>");
    expect(titled).not.toContain("<expanded:implement>");
    expect(titled).toContain('title="$implement"');
  });

  it("carries the prefix through `headOfLaunch` (the exported head)", () => {
    // The head is what `expand` receives and what the injection pin reads, so the
    // prefix has to be part of the HEAD and not something `buildLaunchMessage` glues
    // on afterwards — that distinction is the whole of the boundary above, and this
    // case is the one that fails fastest when it is lost. NOTE this case reads the
    // exported function by NAME, so the rename (`headOfMode` → `headOfLaunch`) cannot
    // weaken the boundary pin above it: that pin asserts `expand`'s ARGUMENT and never
    // mentions this identifier. `seen[0] not.toContain("<task")` is the load-bearing
    // assertion and it is untouched by anything done to a name.
    expect(
      headOfLaunch(destination({ promptPrefix: "Frame it first." })),
    ).toBe("Frame it first.\n\nLet's work on Research.\n\n$research");
    expect(
      headOfLaunch(destination({ promptPrefix: "Frame it first." }))).toBe(
      "Frame it first.\n\n" + headOfLaunch(destination()),
    );
    expect(headOfLaunch(destination())).toBe(
      "Let's work on Research.\n\n$research",
    );
  });
});
