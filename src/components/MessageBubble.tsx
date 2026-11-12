import { memo, useState } from "react";
import {
  BotIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  ServerIcon,
  WandSparklesIcon,
} from "lucide-react";
import type { Message } from "../store/sessions";
import { splitMentionBlocks, type MentionBlock, type SkillBlock } from "../lib/skills";
import ToolCallCard from "./ToolCallCard";
import CodemodeCard from "./CodemodeCard";
import SubagentDelegatingCard from "./SubagentDelegatingCard";
import DiffBlock from "./DiffBlock";
import { AgentMarkdown, COPY_GLYPH_WALL } from "./AgentMarkdown";
import { MutedCaption } from "./MutedCaption";
import { cn } from "./lib/utils";
import { useCopyButton } from "../hooks/useCopyButton";
import { Reasoning, ReasoningTrigger, ReasoningContent } from "./Reasoning";
import { Button } from "./ui/button";

/**
 * C7: what `<Button>`'s base and the `ghost`/`default` arms would change at the
 * three `MessageBubble` sites, undone. A bare `<Button>` renders
 * `bg-primary text-primary-foreground h-7 px-2` (`ui/button.tsx:40` sets
 * `defaultVariants {variant:"default"}`), so every site names
 * `variant="ghost"` AND a `size`, and carries its own wall. `ghost` is the arm
 * that matches what all three already were — ink that changes on hover, no fill.
 * Measured with the real `cn()`: for each site the rendered utility SET contains
 * every utility the site spelled before the conversion (nothing lost), and the
 * additions below are the only ones that would have painted.
 *
 * SHARED by all three (`SKILL_HEADER_WALL`, `COPY_GLYPH_WALL`):
 *  - `border-0` — the base's `border` is a 1px ring; preflight sets
 *                 `border: 0 solid`, so none of these sites has one today. It
 *                 would grow every box 2px. With the width at zero the base's
 *                 `bg-clip-padding` is a no-op (padding-box == border-box), so it
 *                 needs no negation even where a background paints.
 *  - `h-auto` / `px-0` — the size's `h-7 px-2` is a fixed 28px tall, 8px-inset
 *                 box. All three sites are content-sized: the header is exactly
 *                 as tall as its label row, the two glyphs are 12px icons.
 *  - `text-[length:inherit]` — the size declares `text-ui-base` and the base
 *                 declares `text-ui-base/relaxed`; `cn` keeps the LAST of the
 *                 font-size group, so this arbitrary-value utility wins BOTH and
 *                 the site keeps the font-size AND the line-height it inherits
 *                 (this is the hazard C7 records: `ChatStreamDirectoryCompletion.test.tsx`'s
 *                 `primaryLines()` finds picker rows with
 *                 `querySelectorAll(".text-ui-base")`, so a site that GAINS the
 *                 token is selected by a test that never saw it).
 *  - `transition-none` — the base's `transition-colors` would fade an ink change
 *                 over 150ms; all three change instantly today. (At the
 *                 attachment badge the base's `transition-colors` is displaced by
 *                 that badge's own `transition-opacity`, which is why no wall
 *                 there spells this.)
 *  - `hover:bg-transparent` — `ghost` adds `hover:bg-hover` and none of these
 *                 sites fills on hover.
 *
 * Provably INERT at all three, so NOT negated: `rounded-md` (no background, no
 * border, so nothing to round — and each site that has a radius spells its own);
 * `outline-none` (`base.css:53-57` forces `outline: none !important` on every
 * focus in every browser, and again under `forced-colors`); `disabled:*` (none of
 * these buttons is ever disabled); `aria-invalid:*` (a `<button>` is never
 * `aria-invalid` here — no form, no field); `group/button` (grep-verified:
 * nothing in the tree reads that group); `has-data-[icon=inline-*]:pr/pl`
 * (lucide sets no `data-icon` attribute); `[&_svg]:pointer-events-none` (the
 * handler is on the button, so the click target moving off the `<svg>` cannot
 * change what runs); `[&_svg]:shrink-0` (every glyph here already spells
 * `shrink-0` or is the only child); `gap-1` (the header spells `gap-2`, which
 * wins; the two glyph sites have exactly one child, so there is no gap to draw);
 * `shrink-0` (the header's parent is a plain block `div`, and the two glyph sites
 * spell `shrink-0` themselves); `whitespace-nowrap` at the glyph sites (a 12px
 * icon has no text to wrap); `select-none` at the glyph sites (an icon carries no
 * selectable text); `justify-center`/`items-center` at the two glyph sites (the
 * wall restores a BLOCK display, so there is no flex container to distribute in);
 * `bg-clip-padding` (no border, and where a background does paint the clip is
 * padding-box == border-box); `text-foreground`/`hover:text-foreground` and
 * `aria-expanded:text-foreground` at the header (it has no direct text node —
 * both its spans and both glyphs spell their own ink, so the colour it declares
 * is never what paints); `gap-1` at the header (`gap-2` wins);
 * `aria-expanded:bg-hover` at the two glyph sites and the badge (neither is ever
 * `aria-expanded` — only the skill header is, and that one negates it).
 */
const SKILL_HEADER_WALL =
  "border-0 h-auto px-0 justify-start whitespace-normal transition-none select-auto text-[length:inherit] hover:bg-transparent aria-expanded:bg-transparent";

// `COPY_GLYPH_WALL` — the C7 wall the doc-comment above names as SHARED by the
// code fence's `Copy code` glyph and this file's `Copy response` glyph — MOVED to
// `./AgentMarkdown` with the fenced-code block that also reads it (issue #180's
// extraction). It lives THERE and is imported here rather than duplicated, because
// the two glyphs are the same shape and one wall must keep them identical, and
// because importing it the other way (`AgentMarkdown` → `./MessageBubble`) would
// make the two modules a cycle: this file already imports `AgentMarkdown`.

/**
 * One `<skill>` block injected into a user message: a collapsible card
 * (COLLAPSED by default — ZCode's `ToolLayout` defaults `isOpen` to
 * `false`), styled after the `ToolCallCard`/`FileSummaryCard` conventions:
 * icon + muted label + mono name + a chevron that rotates on open.
 */
function SkillBlockCard({ block }: { block: SkillBlock }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg bg-input px-3 py-2">
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(SKILL_HEADER_WALL, "flex w-full items-center gap-2 text-left")}
      >
        <WandSparklesIcon className="size-4 shrink-0 text-foreground-subtle" />
        <span className="shrink-0 whitespace-nowrap font-medium text-foreground-subtlest">
          Skill
        </span>
        <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
          {block.name}
        </span>
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "ml-auto size-4 shrink-0 text-foreground-subtlest transition-transform",
            open ? "rotate-90" : "rotate-0",
          )}
        />
      </Button>
      {open && (
        <div className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-ui-sm text-foreground-subtle">
          {block.body}
        </div>
      )}
    </div>
  );
}

/**
 * One `@`-agent / `#`-MCP block: the SOFT hint the user's mention injected.
 *
 * Deliberately a compact SINGLE-LINE chip and NOT a collapsible card like
 * `SkillBlockCard`: the block body is a two-sentence nudge ("the user NAMED
 * this resource — the agent may still reason it isn't needed"), not a
 * document worth hiding, so there is no chevron, no expand, and the body is
 * NOT rendered at all (the chip says what happened; the agent's own
 * dispatch/connect row in the transcript is the proof it acted on it).
 */
function NamedResourceChip({ block }: { block: MentionBlock }) {
  // `block.body` is parsed but deliberately NOT rendered: the block is a soft
  // pointer for the AGENT, and the chip only tells the user what they named —
  // expanding the prose hint in the UI would add noise.
  const Icon = block.kind === "agent" ? BotIcon : ServerIcon;
  return (
    <div className="flex items-center gap-2 rounded-lg bg-input px-3 py-2">
      <Icon className="size-4 shrink-0 text-foreground-subtle" />
      <span className="shrink-0 whitespace-nowrap font-medium text-foreground-subtlest">
        {block.kind === "agent" ? "Agent" : "MCP"}
      </span>
      <span className="min-w-0 truncate font-mono text-ui-sm text-foreground-subtle">
        {block.name}
      </span>
      <MutedCaption>named by the user</MutedCaption>
    </div>
  );
}

/**
 * The agent's reply: the text on a BAND, with a copy button below it.
 *
 * A NAMED component (not inline JSX in the `switch`) because it holds hooks —
 * the `useCopyButton` call (which owns what used to be a local
 * `useState`/`useRef`/`useEffect` trio) cannot live in a `switch` arm of a
 * component whose other arms return early (`MessageBubble` itself may render a
 * `user` / `tool-call` / `diff` bubble and skip the call entirely, which would
 * change the hook count between renders).
 *
 * THE BAND mirrors the user band (`case "user"` above) and reuses its TOKEN:
 * `bg-composer`, never a copied hex. The palette gives `--color-composer` and
 * `--color-input` the same value today and splits them so a theme can move one
 * without dragging the other; both bands are "the composer's text coming back",
 * so they move together and stay apart from a theme's input surface.
 *
 * `[overflow-wrap:anywhere]` is deliberately NOT copied from the user band:
 * that one renders the raw sentence (a pasted URL must break mid-token), while
 * `AgentMarkdown` renders block elements that prose already wraps.
 *
 * RETURNS A FRAGMENT, not a wrapper `<div>`: `MessageList`'s row wrapper is the
 * flex item here, and `MessageBubble.test.tsx` pins the fragment (the markdown
 * scale itself moved to `AgentMarkdown.test.tsx` with the extracted component,
 * and reads its root as `container.firstElementChild` — the band is this
 * component's, so one more element on that path would shift those assertions).
 */
function AgentText({ text }: { text: string }) {
  // Copy → confirm for 1.5s, owned by `useCopyButton` (the timer, the
  // restart-on-second-click and the unmount cleanup all live there now). The
  // BUTTON stays below, at the call site — see the hook's doc-comment for why.
  // The PROP is what gets copied, so the clipboard receives the markdown
  // SOURCE — backticks, table pipes and all. Reading the rendered DOM back
  // would hand over the text with its markup stripped.
  const { copied, copy: handleCopy } = useCopyButton(text);

  return (
    <>
      {/* THE MARGINS, and why one of them is NEGATIVE.
          `MessageList`'s scroll container is `flex flex-col gap-3` (12px), and a
          flex item's margins ADD to a gap — they can never subtract from it, so
          `mt-0` cannot pull this reply closer to the `Thought` above it than
          12px. `-mt-2` (−8px) is the only way to reach the agreed 4px:
          12 − 8 = 4. `mb-5` (20px) then measures 12 + 20 = 32px below the reply,
          which is the gap a user message already produces under its own band
          (`user-message` carries `my-5`, pinned in `MessageBubble.test.tsx`).
          DO NOT "clean up" the negative margin: removing it does not break the
          layout tests, it silently re-separates the `Thought` row from the reply
          it belongs to — back to 12px, and the pair reads as two rows again.
          They live on the BAND (not on a unit wrapper as in `case "user"`)
          because `agent-text` has no siblings; the user case must put `my-5` on
          its unit precisely because its mention cards and image grid are
          siblings that a band margin would push away. */}
      <div
        data-testid="agent-band"
        className="-mt-2 mb-5 rounded-xl bg-composer px-3 py-2 text-ui-base text-foreground"
      >
        <AgentMarkdown text={text} />
      </div>
      {/* OUTSIDE and BELOW the band, always visible, and pushed to the END
          (right) edge: the reply's surface is the message, the button is a tool
          on it — inside the band it would sit on the composer fill and compete
          with the last line of prose. Under the band reads as a caption for
          what it produced, not a control before it. The distinct accessible
          name (`Copy code` belongs to a code fence) is what lets a test tell
          the two buttons apart in one render. */}
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy response"}
        title={copied ? "Copied" : "Copy response"}
        data-testid="copy-response"
        // `self-end`: the row wrapper is a `flex-col` (MessageList), whose
        // children default to `stretch`, so without this the 12px icon sat at
        // the START of a button as wide as the column. Aligning to the cross-
        // axis end both shrinks the hit area to the icon and right-aligns it —
        // `w-fit` alone would have kept it on the left, and `ml-auto` is a
        // margin fighting stretch where alignment is the lever. `<Button>`'s
        // base spells no `self-*`, so this survives the merge untouched, and
        // `MessageBubble.test.tsx` reads it straight off this node's className.
        // C7: `COPY_GLYPH_WALL` is what keeps the box the size of the icon — the
        // size's `h-7 px-2` would have made it a 28px tall plate with the glyph
        // centred in it, and `self-end` alone cannot undo that.
        className={cn(
          COPY_GLYPH_WALL,
          "self-end shrink-0 text-foreground-subtle hover:text-foreground",
        )}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </Button>
    </>
  );
}

// Memoized: during a live turn EVERY thought/text chunk replaces only the
// trailing message object in the reducer — every other bubble receives the
// SAME reference. Without this, each chunk re-rendered the whole transcript
// (a full ReactMarkdown re-parse per agent-text bubble), which made the app
// render real slow. Only the changed bubble re-renders now.
export default memo(
  function MessageBubble({
    message,
    isStreaming = false,
    sessionId,
  }: {
    message: Message;
    isStreaming?: boolean;
    /**
     * The ACP session id (optional — the `SubagentTranscript`'s
     * `MessageBubble` does not pass it; a subagent session never has a
     * `subagent` tool call, so the `subagent` branch is never taken there).
     */
    sessionId?: string;
  }) {
    switch (message.kind) {
      case "user": {
        // THE USER'S TEXT RIDES A BAND on the composer's own fill
        // (`bg-composer`): these were the only words in the transcript with no
        // surface of their own, so they read as part of the column rather than
        // as something the user put there. The TOKEN is deliberate, not
        // `bg-input` and not a one-off hex — the palette gives `--color-composer`
        // and `--color-input` the same value today and splits them on purpose so
        // a theme can move one without dragging the other. The user's text is
        // the composer's text coming back, so it wears the composer's token and
        // matches the box it was typed in under every palette.
        //
        // FULL WIDTH, and that width is FREE: `MessageList`'s row wrapper is a
        // `flex-col`, whose children stretch by default, so a plain block-level
        // `div` spans the chat column and ends where the column's `p-4` ends.
        // The earlier shrink-wrap — `inline-block`, `self-start`, `max-w-[85%]`
        // — is all gone, and none of the three may creep back: each ONE
        // silently re-narrows the band (`self-start` alone overrides the
        // stretch; `inline-block` makes the box shrink-to-fit even in a flex
        // column that is not). `rounded-xl` stays — a full-width band with
        // square corners would read as a table row, not as the user's message.
        // NO border (asked for). Measured in a real browser against the built
        // CSS, sampling the rendered pixels — the fill against the chat column
        // is 1.11 (Dracula), 1.12 (default dark) and 1.08 (default light, `#ffffff` on
        // a `#f6f6f6` column). All three are faint boundaries — well under the
        // 3:1 a non-text boundary ideally wants — and default light is the weakest:
        // there the band reads as a barely-there tint. That is the cost of the
        // border going, and no existing token avoids it (`--color-card`,
        // `--color-input` and `--color-header` are all the same `#ffffff` in
        // that palette), so strengthening it further would need a border back or
        // a new token. Accepted knowingly — do not "fix" it unasked.
        //
        // ONLY the text is in the band. The mention rows below stay where
        // they were, on the column, because `SkillBlockCard` /
        // `NamedResourceChip` paint `bg-input` — in the default palettes that is the
        // SAME colour as `bg-composer`, so inside the band each card's edge
        // would vanish. The band is the user's sentence; the rows are
        // annotations about it.
        //
        // `my-5` = 20px (this repo's `--spacing` is `.25rem`, root font-size is
        // never overridden) separates the band from the transcript around it.
        // The OBSERVED gaps are larger than 20px because a flex item's margins
        // do not collapse, so they stack on the container's own rhythm —
        // measured in a browser against the built CSS: 32px (20 + the `gap-3`
        // 12px) between plain neighbours, 48px (20 + 12 + the breathing
        // `mt-4` 16px) beside a tool row. That is the transcript saying "a new
        // kind of row starts here" twice over; only the band gets these
        // margins, every other row type keeps its existing rhythm.
        //
        // `expandMentions` appends `<skill>` / `<agent>` / `<mcp>` blocks
        // after the user's text; render the blocks as a collapsible card
        // (skill — collapsed by default) or a compact soft-hint chip
        // (agent / MCP) instead of raw text — display-only, the
        // persisted/sent text is unchanged. Images render as a read-only
        // thumbnail grid (the transcript is history — NO remove buttons).
        // `data:` URLs are safe here: the transcript is local.
        const { text, blocks } = splitMentionBlocks(message.text);
        return (
          // THE UNIT carries the 20px, not the band. The mention rows and the
          // image grid below are SIBLINGS of the band (annotations of this
          // message, 8px under it via `mt-2`), so a `my-5` on the BAND would
          // land between a sentence and its own annotations: measured, they sat
          // 28px from the sentence they describe and 12px from the next row of
          // the NEXT message — the association inverts. On the unit the band
          // keeps its 8px neighbours (re-measured: 8px) and the whole user
          // message stands apart.
          // This div is a flex ITEM of `MessageList`'s row wrapper, so it
          // starts a new formatting context and its children's `mt-2` stays
          // INSIDE it rather than collapsing out — hence a text-only message
          // begins exactly at the band (measured: unit.top == band.top, 32px
          // under a plain neighbour = 20 + the container's `gap-3`), and a
          // text-less one (images only) begins 20px down with its images a
          // further 8px below that. The 20px also stacks on the breathing
          // `mt-4` next to a tool row: 48px, measured.
          <div className="my-5" data-testid="user-message">
            {text === "" ? null : (
              // An image-only message has no text: an empty band would be a
              // padded stripe with nothing in it — a paint artefact, not a
              // message. See the block comment above for the width, the fill
              // and the no-border decision.
              <div
                data-testid="user-band"
                className="whitespace-pre-wrap rounded-xl bg-composer px-3 py-2 [overflow-wrap:anywhere] text-ui-base text-foreground"
              >
                {text}
              </div>
            )}
            {blocks.length > 0 && (
              <div className="mt-2 flex flex-col gap-2">
                {blocks.map((block, i) =>
                  block.kind === "skill" ? (
                    <SkillBlockCard key={i} block={block} />
                  ) : (
                    <NamedResourceChip key={i} block={block} />
                  ),
                )}
              </div>
            )}
            {message.images && message.images.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-2">
                {message.images.map((img, i) => (
                  <img
                    key={i}
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={img.name}
                    title={img.name}
                    className="max-h-48 max-w-64 rounded-lg border border-input-border object-contain"
                  />
                ))}
              </div>
            )}
          </div>
        );
      }

      case "agent-text":
        return <AgentText text={message.text} />;

      case "agent-thought":
        return (
          <Reasoning
            isStreaming={isStreaming}
            autoCollapseKey={isStreaming ? null : "complete"}
          >
            <ReasoningTrigger streamingText={message.text} />
            <ReasoningContent>{message.text}</ReasoningContent>
          </Reasoning>
        );

      case "tool-call":
        return (
          <div className="w-full">
            {message.title === "codemode" ? (
              <CodemodeCard
                title={message.title}
                status={message.status}
                rawInput={message.rawInput}
                rawOutput={message.rawOutput}
                isStreaming={isStreaming}
              />
            ) : message.title === "subagent" ? (
              <SubagentDelegatingCard
                title={message.title}
                status={message.status}
                rawInput={message.rawInput}
                rawOutput={message.rawOutput}
                sessionId={sessionId ?? ""}
              />
            ) : (
              <ToolCallCard
                title={message.title}
                status={message.status}
                diff={message.diff}
                rawInput={message.rawInput}
                rawOutput={message.rawOutput}
              />
            )}
          </div>
        );

      case "diff":
        return (
          <div className="w-full">
            <DiffBlock path={message.path} patch={message.patch} />
          </div>
        );
    }
  },
);
