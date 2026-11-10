import { describe, expect, it } from "vitest";
import {
  buildLaunchMessage,
  escapeAttr,
  headOfMode,
  skillOfMode,
  stageOfMode,
  taskBlock,
  TASK_LAUNCH_MODES,
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
 *  4. each mode names exactly one skill and at most one preferred column, so no
 *     surface re-spells `"discuss"` / `"research"` / `"backlog"` as a literal.
 *
 * WHY THESE ARE NOT component tests: every rule here is a rule about a STRING, and
 * a component test can only see a string by driving a whole chat surface (which is
 * what `NewTaskDialog.test.tsx` pays to do). Asserting it here instead means the
 * detail modal and the New Task modal are pinned against ONE implementation.
 */

/** An expander that changes nothing — for the cases that only care about ORDER. */
const identity = (t: string): string => t;

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

describe("taskPrompt — the launch draft", () => {
  it("puts the skill block before the task block, never after", () => {
    // ADR 0013's expansion turns `$discuss` into a `<skill>` block, and the task
    // block must sit AFTER it: context frames the request, it does not follow it.
    // `NewTaskDialog.test.tsx` pins this same ordering for the composer path, so
    // the two surfaces cannot drift.
    const message = buildLaunchMessage(task(), "discuss", identity);
    expect(message).toContain("$discuss");
    expect(message.indexOf("$discuss")).toBeLessThan(message.indexOf("<task "));
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
    buildLaunchMessage(task({ title: "$deploy", body: "$other-skill" }), "discuss", (t) => {
      seen.push(t);
      return t.toUpperCase();
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toContain("<task");
    expect(seen[0]).not.toContain("$deploy");
    expect(seen[0]).not.toContain("$other-skill");
    expect(seen[0]).toContain("$discuss");
    // And the block rode through the expander untouched — the expander upper-cased
    // the head and NOTHING else, so the card's text is byte-identical below it.
    const message = buildLaunchMessage(task({ title: "$deploy" }), "discuss", (t) =>
      t.toUpperCase(),
    );
    expect(message).toContain('title="$deploy"');
    expect(message.slice(0, message.indexOf("<task "))).toBe(
      seen[0].toUpperCase() + "\n\n",
    );
  });

  it("names the mode's skill as a $ token so the ONE expansion path handles it", () => {
    // There is deliberately no second skill-injection code path (the same rule
    // `NewTaskDialog`'s dropdown follows). A token is what `expandMentions` reads.
    expect(headOfMode("research")).toContain("$research");
    expect(headOfMode("research")).not.toContain("$discuss");
    expect(headOfMode("backlog")).not.toContain("$");
  });

  it("carries an instruction line, because a card-only message says no verb", () => {
    // The Session has no user prose to send — the card IS the request — so without
    // this the message is two XML blocks and nothing that says what to do.
    expect(headOfMode("research")).toContain("Research this task.");
    expect(headOfMode("backlog")).toBe("");
  });
});

describe("taskPrompt — the mode table", () => {
  it("has exactly the three buttons the two surfaces spell", () => {
    expect(TASK_LAUNCH_MODES).toEqual(["backlog", "discuss", "research"]);
  });

  it("maps discuss and research to their skills and backlog to none", () => {
    // `backlog` never opens a Session, so it loads no skill. Leaving it `null`
    // rather than `"backlog"` is what stops a caller from emitting a `$backlog`
    // token that no catalog has — an unmatched token rides the text VERBATIM and
    // the model would see a literal `$backlog`.
    expect(skillOfMode("backlog")).toBeNull();
    expect(skillOfMode("discuss")).toBe("discuss");
    expect(skillOfMode("research")).toBe("research");
  });

  it("names a preferred column only for the two modes that file a card", () => {
    // `research` transitions the ticket to Research (PR #178); `discuss`
    // deliberately does NOT move an existing card — a click whose job is to start
    // a conversation should not also drag the card across the board.
    expect(stageOfMode("backlog")).toBe("backlog");
    expect(stageOfMode("discuss")).toBeNull();
    expect(stageOfMode("research")).toBe("research");
  });

  it("declares the preferred columns as SEEDED slugs, so callers must check first", () => {
    // A vacuity guard for the claim above: these strings must match the Rust
    // `DEFAULT_STAGES` table, and a rename there silently makes both surfaces
    // file into a column that does not exist. `store/taskLaunch.ts` reads the
    // board and refuses the move when the column is absent — that guard is what
    // makes this constant safe, and it is pinned in that file's tests.
    const src = "backlog,research,approved,doing,done";
    for (const mode of TASK_LAUNCH_MODES) {
      const slug = stageOfMode(mode);
      if (slug !== null) expect(src.split(",")).toContain(slug);
    }
  });
});
