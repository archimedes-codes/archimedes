import type {
  AgentOverride,
  AgentOverrideFields,
  OverrideSource,
} from "../../lib/tauri";
import { foldAscii } from "../../lib/agentOverrides";

/** A field's label for the layer that supplied it (ADR 0068's label space).
 *
 * `parent` means "nothing below the explicit `subagent` tool param spoke" — the
 * row does NOT claim the child will inherit, because a dispatch that passes
 * `model:` overrides what this row shows. That is why the rung is worded
 * "Inherits parent" and not "the child inherits". */
export function sourceLabel(source: OverrideSource, field: string): string {
  switch (source) {
    case "override":
      return "override";
    case "file":
      return "file";
    case "parent":
      return `Inherits parent${field === "tools" ? " tools" : ""}`;
  }
}

/**
 * The tools row's inherit copy (ADR 0067: the tools control's empty state must
 * be LABELLED, not silent — "an empty picker that implies no tools would be a
 * lie users act on"). With no `tools` key written, the child falls to the next
 * layer, and the wording names it.
 *
 * Anything that is not `file` reads the parent rung, which is ADR 0067's literal
 * copy: the only layers Rust can report beneath an ABSENT override are `file` and
 * `parent`, so a stale `override` (a row fetched before the key was cleared) is
 * the just-cleared state, and "Inherits parent tools" is what the user needs to
 * read there.
 */
export function toolsInheritLabel(source: OverrideSource): string {
  return source === "file" ? "Inherits the file's tools" : "Inherits parent tools";
}

/**
 * The shadowing report's heading for one row (ADR 0065: disclosed, never listed).
 *
 * The clause names the WINNER's scope (the CAUSE), never the excluded entry's —
 * the rule `SkillsDialog`'s `shadowGroups` comment earns and this inherits:
 * `space_roots()` contributes two roots per level (`.agents/agents`, then
 * `.pi/agents`) and `user_roots()` returns two User roots, so a `user` entry can
 * be excluded by a `user` winner, and a clause keyed on the loser is FALSE in
 * shipped configurations. Here the winner is the row itself, so its scope is
 * already in hand.
 */
export function shadowHeading(winnerScope: "space" | "user", count: number): string {
  return `${count} ${count === 1 ? "agent is" : "agents are"} shadowed by a ${
    winnerScope === "space" ? "space" : "global"
  } agent with the same name`;
}

/** The `edited` set's key for one row-field (see `patch`). Folded, because a row
 *  and the map key it matched can differ in case, and both write the same field. */
export function editedKey(name: string, field: keyof AgentOverride): string {
  return `${foldAscii(name)}\u0000${field}`;
}

/** The empty suppression set (see `edited`): allocated ONCE so the "nothing is
 *  suppressed" identity is stable across renders — it is handed down as a prop. */
export const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The row's stored-pin DISAGREEMENT line (`row.override` vs the store-side map).
 *
 * `row.override` is the stored entry as the BACKEND's selector read it — the
 * supervisor's `override_layer` scan, which takes the first key the `HashMap` hands
 * back. The picker is bound to the live settings document, looked up by this
 * dialog's own ASCII-fold scan, which takes the first key in DOCUMENT order. Two
 * selectors over one map, so they agree everywhere except in the case they both
 * exist to handle: hand-edited case-fold twins (`"Scout"` beside `scout` — Rust
 * picks one by HashMap luck, the picker the other by insertion order) and a
 * `settings.json` the desktop has not re-read since something else wrote it. The
 * user then sees one pin while the dispatch launches with the other, and nothing on
 * the row says so. This is also where the ADR 0023 soft-degrade story gets a
 * visible home: what you pinned and what runs are different columns, and now a
 * stored pin can differ from the one the picker edits.
 *
 * Returns one clause per disagreeing field (an EMPTY list = nothing to say, which
 * is the ordinary case). A `null` on the wire means "the backend found no stored
 * value for this field", which is not a disagreement with a field the picker also
 * shows as unset — hence the `!== null` guard on every arm. The tool list compares
 * as the string the row prints, because that is what the user is reading.
 *
 * `edited` names the fields THIS dialog has written since it mounted, and they are
 * skipped. `row.override` is a FETCH-time value — the same lag the `runs` columns
 * carry — so the moment the user picks a different model the wire column differs
 * from the store-side map on purpose, and the backend already has the newer value.
 * Calling a difference the user just caused "the stored pin the last fetch saw
 * differs" would be the reverse of the honesty this line exists for. What is worth
 * naming is a disagreement the modal did NOT cause, and it runs BOTH ways: the file
 * moved under a fetch that predates it (Rust remembered a thinking level, something
 * else wrote `settings.json`, or this modal's own save failed and rolled the store
 * back to the file), and two selectors reading one map differently (the case-fold
 * twin). Hence the PAST tense in the copy — the line reports what the last FETCH saw,
 * which is a fact about a finished read, not a claim about what the backend reads now.
 * A save that failed clears the suppression entirely (see `rolledBackWrites`), so the
 * first of those cases cannot be silenced by a write that never landed.
 */
export function storedPinDiff(
  rowName: string,
  wire: AgentOverrideFields,
  stored: AgentOverride | undefined,
  edited: ReadonlySet<string>,
): string[] {
  const parts: string[] = [];
  const says = (field: keyof AgentOverride, text: string) => {
    if (!edited.has(editedKey(rowName, field))) parts.push(text);
  };
  if (wire.model !== null && wire.model !== stored?.model) {
    says("model", `model ${wire.model}`);
  }
  if (wire.thinking !== null && wire.thinking !== stored?.thinking) {
    says("thinking", `thinking ${wire.thinking}`);
  }
  if (
    wire.tools !== null &&
    wire.tools.join(", ") !== (stored?.tools ?? []).join(", ")
  ) {
    says("tools", `tools ${wire.tools.join(", ") || "—"}`);
  }
  return parts;
}
