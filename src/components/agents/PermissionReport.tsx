import type {
  AgentDefinitionReportDto,
  AgentFrontmatterNote,
} from "../../lib/tauri";
import { MutedCaption } from "../MutedCaption";
import { LayerTag } from "./LayerTag";
import { sourceLabel } from "./agentLabels";

/** The declared-permission lines for one row (see the render site above).
 *
 *  DISPLAY ONLY — no control, no `onPatch`, no new prop. The rules are authored
 *  in the definition FILE; a control here would promise an edit this component
 *  cannot perform, which is the same reason the shadow report is plain text.
 *
 *  NOTHING SORTS. `row.filePermission.tools` is an ordered array of pairs and
 *  each `rules.patterns` is an ordered list, both in FILE order, because
 *  opencode resolves a tool's pattern object in order and the LAST matching
 *  rule governs. A `.sort()` here would print a sequence in which a different
 *  rule appears to decide than the one that actually does — the silent-no-op
 *  class #101 exists to fix, arriving from the display side.
 *
 *  The empty case returns `null` like `ShadowReport`: a file that says nothing
 *  about permissions has nothing to disclose, and the ordinary row stays lean. */
export function PermissionReport({ row }: { row: AgentDefinitionReportDto }) {
  // `?? []` is the same IPC tolerance `ShadowReport` keeps for a row that
  // genuinely predates the field — a bare `flatMap` over such a row yields
  // `undefined` entries that throw on the first property access. `filePermission`
  // is `| null` (Rust `Option`), so the nullish read is the field's own contract,
  // not a dodge.
  const tools = row.filePermission?.tools ?? [];
  const notes: AgentFrontmatterNote[] = row.frontmatterNotes ?? [];
  if (tools.length === 0 && notes.length === 0) return null;

  return (
    <div
      data-permission-report=""
      className="flex min-w-0 flex-col gap-0.5 pt-1"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        {/* The SAME label span the Model/Thinking lines use, and the SAME
            `LayerTag` element — ADR 0068's label space is `override` / `file` /
            `Inherits parent` and nothing else, so the block prints the layer
            Rust named (`source.permission`: `file` exactly when the block
            exists) through the existing vocabulary rather than a second one. */}
        <span className="w-16 shrink-0 text-ui-sm text-foreground-subtlest">
          Permission
        </span>
        <LayerTag>{sourceLabel(row.source.permission, "permission")}</LayerTag>
      </div>

      {tools.map(([tool, rules], toolIndex) => {
        // `ToolKey::Unrecognized` arrives as the tagged OBJECT
        // `{"unrecognized":"glob"}`; the eleven recognised keys arrive as bare
        // camelCase verbs. Both print the name — an unrecognised key is retained
        // and named, never dropped (#101's whole premise).
        const name = typeof tool === "string" ? tool : tool.unrecognized;
        // The ONE case the `whole_tool` flag exists for: Rust stores a bare
        // `bash: deny` as the catch-all `"*"` row PLUS the flag, so the file said
        // "tool-wide" and printing the stored `"*"` would report a pattern the
        // file never wrote. An explicit `{"*": deny}` map is the same row
        // WITHOUT the flag, and it prints its star, because that star is what
        // the file actually said.
        if (rules.whole_tool) {
          const action = rules.patterns[0]?.action;
          return (
            <MutedCaption
              as="div"
              key={`${name}#${toolIndex}`}
              data-permission-rule=""
              className="flex min-w-0 flex-wrap items-center gap-x-2"
            >
              <span className="min-w-0 shrink-0">{name}</span>
              <span className="min-w-0 truncate">
                {action === undefined ? "—" : `→ ${action}`}
              </span>
            </MutedCaption>
          );
        }
        // One line per pattern row, in the order received. `patterns` can be
        // EMPTY — a tool whose verdict was unreadable keeps its slot with
        // `Rules::default()` — and that row says so rather than vanishing, since
        // a tool the file named but the reader could not parse is exactly the
        // case the user needs to see.
        if (rules.patterns.length === 0) {
          return (
            <MutedCaption
              as="div"
              key={`${name}#${toolIndex}`}
              data-permission-rule=""
              className="flex min-w-0 flex-wrap items-center gap-x-2"
            >
              <span className="min-w-0 shrink-0">{name}</span>
              <span className="min-w-0 truncate">
                — no rule the reader could use
              </span>
            </MutedCaption>
          );
        }
        return rules.patterns.map((rule, ruleIndex) => (
          <MutedCaption
            as="div"
            // The index is part of the key on purpose: a tool's pattern list may
            // legitimately repeat a pattern (`"*"` twice with different
            // verdicts — last one wins), so the pattern alone is not unique.
            key={`${name}#${toolIndex}#${ruleIndex}`}
            data-permission-rule=""
            className="flex min-w-0 flex-wrap items-center gap-x-2"
          >
            <span className="min-w-0 shrink-0">{name}</span>
            <span className="min-w-0 shrink-0">{rule.pattern}</span>
            <span className="min-w-0 truncate">→ {rule.action}</span>
          </MutedCaption>
        ));
      })}

      {notes.map((note, index) => (
        // One line per note, in the order Rust sent them. Each names BOTH the
        // kind and the verbatim offending spelling: an announcement the user
        // cannot act on is noise, and noise trains people to ignore the feature.
        <MutedCaption key={`note#${index}`} as="p" className="min-w-0 truncate">
          {describeNote(note)}
        </MutedCaption>
      ))}
    </div>
  );
}

/** One announce note, in words. Discriminated on the KEY, because an externally
 *  tagged enum carries no `kind` field — the key IS the discriminant
 *  (`{"unknownKey":"mode"}`), which is the whole reason the Rust side could not
 *  use `#[serde(tag = "kind")]` with a bare `String` payload. */
function describeNote(note: AgentFrontmatterNote): string {
  if ("unknownKey" in note) return `unknown key: ${note.unknownKey}`;
  if ("unrecognizedToolKey" in note) {
    return `unrecognised tool key: ${note.unrecognizedToolKey}`;
  }
  if ("unsupportedUnvalidatedMatcher" in note) {
    // The scope line (issue #101): a `bash` pattern object is PARSED — the block
    // above shows it — but this desktop has no validated matcher for command
    // text, so it is announced and NOT enforced. Saying "parsed but not
    // enforced" is the honest sentence; saying only "unsupported" would imply the
    // rules vanished. A path-taking tool's pattern map is the same story on the
    // other axis: parsed and announced, never enforced, because this layer does
    // no path resolution at all. The fall-through stays for any reason the Rust
    // enum gains later — a name we cannot phrase still gets reported verbatim.
    return note.unsupportedUnvalidatedMatcher === "bashPatternRules"
      ? "bash pattern rules are parsed but NOT enforced"
      : note.unsupportedUnvalidatedMatcher === "pathPatternRules"
        ? "path pattern rules are parsed but NOT enforced"
        : `unsupported matcher: ${note.unsupportedUnvalidatedMatcher}`;
  }
  return `unknown action: ${note.unknownAction}`;
}
