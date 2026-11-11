import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createHighlighter, type Highlighter } from "shiki";
import { CheckIcon, CopyIcon } from "lucide-react";
import OpenAnchor from "./OpenAnchor";
import { Button } from "./ui/button";
import { useSettings } from "../store/settings";
import type { AppPalette } from "../lib/theme";
import { fileIconFor } from "../lib/fileIcons";
import { cn } from "./lib/utils";
import { useCopyButton } from "../hooks/useCopyButton";

/**
 * The markdown renderer the transcript and the Task artifact reader share.
 *
 * EXTRACTED VERBATIM from `MessageBubble.tsx` (issue #180 D1: a Task artifact is
 * markdown, and rendering it as `whitespace-pre-wrap` prose in the one surface
 * built for reading it would be the wrong trade). The move is a PURE relocation —
 * every class string, comment and behaviour below is what `MessageBubble` already
 * rendered, and `AgentMarkdown.test.tsx` (moved with it, fixtures byte-identical)
 * is the proof: it pins the ZCode scale assertion-by-assertion through the REAL
 * `ReactMarkdown`.
 *
 * The whole self-contained subtree travels together, because `AgentMarkdown` is
 * the only consumer of any of it: the shared highlighter singleton, the palette →
 * syntax-theme mapper, the code body class, the fenced `CodeBlock`, and the
 * External-open URL policy. `CodeBlock`'s `COPY_GLYPH_WALL` travels too and is
 * EXPORTED, because the reply's `Copy response` glyph in `MessageBubble`'s
 * `AgentText` reads the SAME wall — duplicating the string would let the two copy
 * glyphs drift, and importing it back from `./MessageBubble` would make the two
 * modules a cycle.
 *
 * `CODE_BODY_CLASS` deliberately stays a module-private const HERE, even though
 * `CodemodeCard.tsx` carries a line-identical private copy: two components with no
 * relationship to each other each own their own body class, and importing across
 * files would couple them for a cosmetic win.
 */

/**
 * C7 wall for the two always-visible 12px copy glyphs (the code fence's
 * `Copy code` and the reply's `Copy response`). Both are the same shape — an
 * icon-only button whose display is the UA's `inline-block` — so one wall serves
 * both. `inline-block` is restored rather than argued away because the display
 * group is the one thing that could move the glyph inside its own box: under
 * flex the base's `items-center justify-center` would centre, and at the
 * `copy-response` site the button is a flex ITEM of a `flex-col`, where
 * `inline-block` blockifies to `block` and `self-end` shrinks it to the icon.
 * `justify-start` is spelled because the base centres on the main axis.
 */
export const COPY_GLYPH_WALL =
  "border-0 inline-block h-auto px-0 justify-start transition-none text-[length:inherit] hover:bg-transparent";

/**
 * One shared highlighter for the whole app.
 *
 * BOTH syntax themes are loaded in this ONE call (ADR 0027): switching
 * palette then only re-runs `codeToHtml` against themes the singleton already
 * holds — no second highlighter, no re-instantiation, no flash of unhighlighted
 * code. (`createHighlighter` is the expensive part — grammars + themes — so a
 * per-palette instance would pay it twice for a purely cosmetic axis.)
 *
 * `tsx` / `jsx` are in the `langs` list because they are the alias grammars a
 * coding agent emits by far the most. Shiki THROWS on a lang outside this list
 * (`Language `tsx` not found`), the `codeToHtml` call site below catches it,
 * and the catch renders the plain fallback — so before these two entries
 * existed every tsx / jsx fence was silently UNHIGHLIGHTED with no error
 * anywhere. `css` / `html` / `markdown` / `vue` are still absent and still
 * fall back the same way (a known gap, deliberately not widened here).
 */
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ["github-dark", "dracula"],
      langs: [
        "bash",
        "rust",
        "typescript",
        "javascript",
        "tsx",
        "jsx",
        "json",
        "python",
        "toml",
        "yaml",
      ],
    });
  }
  return highlighterPromise;
}

/**
 * (ADR 0027) The syntax theme DERIVES from the palette — no separate setting.
 *
 * Deliberately a one-line pure function exported for tests: the rule is then
 * assertable without a DOM, and the render tests below only have to prove the
 * rule is WIRED into `codeToHtml` (via the theme's own paper colour).
 *
 * Anything that is not `"dracula"` — `"zai"`, `null` (settings not loaded /
 * the stored default), `undefined` — answers `github-dark`, which is the
 * behaviour this component had before the palette axis existed. The pairing is
 * coherent in both directions: `dracula` is a DARK syntax theme and only
 * Dracula's dark variant ships here (a scope decision — ADR 0027), so that
 * palette pins the app dark and dark code never sits on a light bubble.
 */
export function shikiThemeFor(
  palette: AppPalette | null | undefined,
): "dracula" | "github-dark" {
  return palette === "dracula" ? "dracula" : "github-dark";
}

/**
 * The ONE body class string, shared by BOTH render branches.
 *
 * It used to be two literals, and they drifted: the fallback `<pre>` carried
 * `p-3` and the highlighted `<div>` did not, so every real fence sat flush
 * against the panel edge while the rare fallback was inset — the opposite of
 * what the doc-comment below promises. Shiki emits no padding (its
 * `<pre class="shiki …">` carries only an inline colour) and no rule in
 * `index.css` pads `pre`, `.shiki` or `code`, so the class was the entire
 * inset. `MessageBubble.codeblock.test.tsx` now asserts the two branches emit
 * the SAME class list, which is only possible while it is one constant.
 *
 * Deliberately NO background class: the highlighted branch must not fight the
 * inline paper colour Shiki writes on its own `<pre>`.
 */
const CODE_BODY_CLASS = "overflow-x-auto p-3 font-mono text-sm";

/**
 * A fenced code block: a bordered panel whose header names the file type
 * (glyph + hue from `fileIconFor`, so a ```tsx fence is the SAME colour as the
 * `.tsx` chip in a tool row) and offers a copy button, above the
 * Shiki-highlighted body. Only the HEADER is a `bg-panel` band: Shiki writes
 * an INLINE `background-color` onto its own `<pre>` (theme paper), which
 * outranks any Tailwind class, so the body is deliberately left unstyled in
 * the background axis — the CSS states what actually renders instead of
 * asserting a class that loses.
 *
 * Why the header is `bg-panel` and not `bg-card`: the descriptor hue it paints
 * is the SAME token a `FileChip` uses, and a `FileChip` rides the transcript
 * column — its row (`TRANSCRIPT_ROW`) carries no background of its own, so the
 * chip shows the column behind it, which is `bg-chat` (`ChatStream.tsx`)
 * = the content slab `#282a36` under Dracula. The raised card is `#343746`
 * and the recessed panel is `#191a21`.
 *
 * The one-step-down shift (amendment to ADR 0027) darkened the raised card
 * enough that all 25 descriptors now clear the 3:1 non-text floor on it (worst
 * `file-py` 3.06) — the seven that failed on the old `#424450` (2.50) now
 * pass. So the header being a recessed `bg-panel` is no longer a legibility
 * requirement: every surface the descriptor can land on clears 3:1 (worst
 * `file-py` 4.50 on the panel `#191a21`, 3.69 on the slab `#282a36`, 3.06 on
 * the raised card `#343746`). The recess is a deliberate band, not a fix. The
 * hues are IDENTITY colours that a palette must not re-hue, so if a palette
 * ever brightens the card again, the surface is what moves — and
 * `fileIconContrast.test.ts` pins both surfaces by TOKEN, so a future move
 * re-measures instead of re-asserting.
 *
 * Header/body separation: the header sits BELOW Shiki's inline `#282A36` paper
 * (`#191a21`, a 1.22 step). It survives because `border-b` is still there and
 * because 1.22 is a visible edge between a band and a body. It is the cost side
 * of the recess, not a free win. `src/lib/fileIconContrast.test.ts` pins both
 * surfaces by TOKEN, so a future move re-measures instead of re-asserting.
 *
 * Ported from ZCode's code block, HEADER ONLY: line numbers, the wrap toggle,
 * Mermaid, the fullscreen viewer and i18n are all out of scope here, and the
 * copy interaction is this repo's own copy→confirm machine (`useCopyButton`:
 * copy → check for 1.5s, timer cleared on unmount) rather than ZCode's.
 *
 * The header renders whether or not the highlight succeeded — the block must
 * never change shape between highlighted and fallback rendering.
 */
function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const [html, setHtml] = useState<string | null>(null);

  // (ADR 0027) Which syntax theme to highlight with. Read straight from the
  // settings store (the same subscription shape `ChatStream` uses for
  // `spinnerStyle`), so a palette change in the settings UI reaches an
  // already-mounted bubble with no reload; `null` (nothing loaded yet, or the
  // stored default) is the zai default.
  const palette = useSettings((s) => s.settings?.palette ?? "zai");

  // Copy → confirm for 1.5s, owned by `useCopyButton` (the timer, the
  // restart-on-second-click and the unmount cleanup all live there now). The
  // BUTTON stays below, at the call site — see the hook's doc-comment for why.
  const { copied, copy: handleCopy } = useCopyButton(code);

  // The identity is derived from a synthetic filename so the fence shares the
  // extension table the file chips use. An absent language is `text` (plain
  // text); an UNKOWN one keeps its own label — `bogus` is more truthful than
  // silently claiming the block is plain text, and it still gets the neutral
  // glyph because `bogus` is not in the table.
  const label = lang?.trim() ? lang.trim().toLowerCase() : "text";
  const descriptor = fileIconFor(`x.${label}`);
  const Icon = descriptor.icon;
  // What Shiki is ASKED for, which is NOT the same string as the label above:
  // `text` is this component's own name for "no language" and Shiki has no such
  // alias (it has `plaintext`), and a `TypeScript` / `JSON` fence must be
  // normalised exactly like the label is. Passing the raw `lang` was a bug:
  // Shiki resolves aliases case-sensitively, so a capitalised fence THREW,
  // the `catch` below rendered the unhighlighted fallback, and the header still
  // showed the lowercased label — the fence looked highlighted and was not.
  const shikiLang = lang?.trim() ? label : "plaintext";

  const header = (
    <div
      data-testid="code-block-header"
      className="flex items-center justify-between gap-2 border-b border-border bg-panel px-3 py-1.5"
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <Icon className={cn("size-3.5 shrink-0", descriptor.className)} />
        <span
          data-testid="code-block-lang"
          className={cn(descriptor.className, "font-mono text-ui-caption lowercase")}
        >
          {label}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="default"
        onClick={handleCopy}
        aria-label={copied ? "Copied" : "Copy code"}
        title={copied ? "Copied" : "Copy code"}
        className={cn(COPY_GLYPH_WALL, "shrink-0 text-foreground-subtle hover:text-foreground")}
      >
        {copied ? (
          <CheckIcon className="size-3" />
        ) : (
          <CopyIcon className="size-3" />
        )}
      </Button>
    </div>
  );

  useEffect(() => {
    let cancelled = false;
    getHighlighter().then((highlighter) => {
      if (cancelled) return;
      try {
        setHtml(
          highlighter.codeToHtml(code, {
            lang: shikiLang,
            theme: shikiThemeFor(palette),
          }),
        );
      } catch {
        setHtml(null);
      }
    });
    return () => {
      cancelled = true;
    };
    // `palette` is a dependency on purpose: it is what makes an ALREADY-mounted
    // fence re-highlight the instant the palette changes (both themes are
    // already loaded, so this is just a re-render of the body).
  }, [code, lang, palette]);

  if (!html) {
    // Unknown / unsupported language (or the highlighter still loading): same
    // panel, same header, plain body.
    return (
      <div className="my-4 overflow-hidden rounded-lg border border-border">
        {header}
        <pre className={CODE_BODY_CLASS}>
          <code>{code}</code>
        </pre>
      </div>
    );
  }
  return (
    <div className="my-4 overflow-hidden rounded-lg border border-border">
      {header}
      <div
        className={CODE_BODY_CLASS}
        // Shiki output is produced locally from the user's own agent output.
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

/** ADR 0051: the External-open policy is Rust-side; this ONLY stops
 * react-markdown blanking the schemes we ALLOW (its default filter is
 * `http|https|irc|ircs|mailto|xmpp`), and keeps refusing the executable ones so
 * no script-bearing href is ever in the DOM. Deliberately NOT percent-encoding —
 * the href goes to the OS verbatim. NOTE this transform governs `img src` too:
 * `data` stays denied, so a markdown `data:` image stays blanked exactly as it
 * is today — do not "widen" DENIED later. */
const DENIED = ["javascript", "data", "vbscript", "blob", "filesystem"];
const SCHEME = /^[a-z][a-z0-9+.-]*$/i;
export function safeUrlTransform(url: string): string {
  const colon = url.indexOf(":");
  const slash = url.indexOf("/");
  const q = url.indexOf("?");
  const hash = url.indexOf("#");
  const relative =
    colon === -1 ||
    (slash !== -1 && colon > slash) ||
    (q !== -1 && colon > q) ||
    (hash !== -1 && colon > hash);
  if (relative) return url;
  const scheme = url.slice(0, colon);
  // The token before `:` must be a LEGAL scheme: micromark hands us an
  // already-percent-encoded destination, so `java&#9;script:` arrives as
  // `java%09script:alert(1)`. A `%` is illegal in a scheme; without this test
  // the override would let through a class the DEFAULT filter refused.
  return SCHEME.test(scheme) && !DENIED.includes(scheme.toLowerCase())
    ? url
    : "";
}

/**
 * The ZCode markdown scale, ported from `zcode/packages/ui/src/components/ai-elements/`
 * (`@tailwindcss/typography` `prose*` classes are NOT used — the component
 * mapping below replaces them):
 * - root: `text-ui-base` on `leading-[1.75] tracking-wide`, first/last block
 *   margins trimmed;
 * - plain `p`: unstyled (preflight zero — paragraphs ride the 1.75 leading);
 * - `strong` `font-medium` (not the default bold);
 * - headings `mt-6 mb-4` + the size/weight ramp (h1 `text-ui-xl` … h6
 *   `text-ui-base` `font-normal`);
 * - lists `my-3` + `space-y-1.5` + `marker:text-foreground-subtlest` (ol is
 *   `list-inside` so multi-digit markers never clip), `li` `pl-1` with direct
 *   `p`s inlined;
 * - blockquote `my-4` + `border-l-2 pl-3 text-foreground-subtle`;
 * - code: inline `font-mono text-ui-sm` on the inline-code token (50%), blocks
 *   `my-4` on a `border border-border` panel at 14px mono — a file-type header
 *   (`bg-panel`) above the body, which keeps Shiki's own paper;
 * - links `text-ui-base font-medium` in the icon-blue token, dotted underline
 *   shown on hover — and an activation is an **External open** (`OpenAnchor`),
 *   never a navigation of the Client's own webview;
 * - tables (the ZCode `markdown-table` scale): a `my-3` frame that is
 *   `overflow-x-auto rounded-xl border border-border` (wide tables scroll
 *   instead of breaking the bubble), the table itself `w-max min-w-full`,
 *   cells `px-3 py-2` with a `border-b` row rule, `th` unbolded +
 *   `text-foreground-subtlest`, `td` `align-top`, rows highlight on hover and
 *   the last row drops its rule.
 *
 * EXPORTED (it was module-private in `MessageBubble.tsx`) because the Task detail
 * dialog renders a Task artifact through it — the reason the extraction happened.
 */
export function AgentMarkdown({ text }: { text: string }) {
  const components = useMemo(
    () => ({
      h1: ({ children }: { children?: ReactNode }) => (
        <h1 className="mt-6 mb-4 text-ui-xl font-semibold">{children}</h1>
      ),
      h2: ({ children }: { children?: ReactNode }) => (
        <h2 className="mt-6 mb-4 text-ui-lg font-semibold">{children}</h2>
      ),
      h3: ({ children }: { children?: ReactNode }) => (
        <h3 className="mt-6 mb-4 text-ui-base font-semibold">{children}</h3>
      ),
      h4: ({ children }: { children?: ReactNode }) => (
        <h4 className="mt-6 mb-4 text-ui-base font-semibold">{children}</h4>
      ),
      h5: ({ children }: { children?: ReactNode }) => (
        <h5 className="mt-6 mb-4 text-ui-base font-medium">{children}</h5>
      ),
      h6: ({ children }: { children?: ReactNode }) => (
        <h6 className="mt-6 mb-4 text-ui-base font-normal">{children}</h6>
      ),
      strong: ({ children }: { children?: ReactNode }) => (
        <strong className="font-medium">{children}</strong>
      ),
      ul: ({ children }: { children?: ReactNode }) => (
        <ul className="my-3 list-outside list-disc space-y-1.5 pl-5 marker:text-foreground-subtlest [&_ul]:my-1.5 [&_ol]:my-1.5">
          {children}
        </ul>
      ),
      ol: ({ children }: { children?: ReactNode }) => (
        <ol className="my-3 list-inside list-decimal space-y-1.5 pl-0 marker:text-foreground-subtlest [&_ul]:my-1.5 [&_ol]:my-1.5">
          {children}
        </ol>
      ),
      li: ({ children }: { children?: ReactNode }) => (
        <li className="pl-1 [&>p]:my-0 [&>p]:inline">{children}</li>
      ),
      blockquote: ({ children }: { children?: ReactNode }) => (
        <blockquote className="my-4 border-border border-l-2 pl-3 text-foreground-subtle [&_p]:my-0 [&_p+p]:mt-2">
          {children}
        </blockquote>
      ),
      // The ZCode `markdown-table` scale: a bordered, horizontally
      // scrollable frame around a content-width table (wide tables scroll
      // instead of breaking the bubble); cells get a bottom border, padding,
      // and a min/max width so long content wraps instead of blowing out a
      // column. (ZCode's virtual scrollbar / toolbar / preview dialog are NOT
      // ported — the app's global native-scrollbar styling covers scrolling.)
      table: ({ children }: { children?: ReactNode }) => (
        <div className="my-3 w-full overflow-x-auto rounded-xl border border-border">
          <table className="w-max min-w-full text-ui-base">{children}</table>
        </div>
      ),
      thead: ({ children }: { children?: ReactNode }) => (
        <thead>{children}</thead>
      ),
      tbody: ({ children }: { children?: ReactNode }) => (
        <tbody>{children}</tbody>
      ),
      tr: ({ children }: { children?: ReactNode }) => (
        <tr className="transition-colors last:[&>td]:border-b-0 hover:bg-hover/20">
          {children}
        </tr>
      ),
      th: ({ children }: { children?: ReactNode }) => (
        <th className="border-border border-b px-3 py-2 text-left font-normal text-foreground-subtlest min-w-16 max-w-md whitespace-normal break-words">
          {children}
        </th>
      ),
      td: ({ children }: { children?: ReactNode }) => (
        <td className="border-border border-b px-3 py-2 text-foreground align-top min-w-16 max-w-md whitespace-normal break-words">
          {children}
        </td>
      ),
      a: ({
        children,
        href,
      }: {
        children?: ReactNode;
        href?: string;
      }) => (
        // An **External open**, not a navigation: a bare `<a href>` here handed
        // the click to the webview, which replaced the Client's own page (the
        // navigation guard refuses that, so the click used to do NOTHING).
        // `OpenAnchor` reads the Space cwd from the context itself, which is why
        // this `useMemo` may keep `[]` deps — see below.
        <OpenAnchor
          href={href ?? ""}
          className="text-ui-base font-medium text-icon-blue no-underline decoration-dotted underline-offset-4 hover:underline"
        >
          {children}
        </OpenAnchor>
      ),
      code({ className, children }: { className?: string; children?: ReactNode }) {
        const codeText = String(children ?? "").replace(/\n$/, "");
        const lang = /language-(\w+)/.exec(className ?? "")?.[1];
        if (lang || codeText.includes("\n")) {
          return <CodeBlock code={codeText} lang={lang} />;
        }
        return (
          <code className="rounded-md bg-markdown-inline-code/50 mx-0.5 px-1.5 py-0.5 font-mono text-ui-sm [overflow-wrap:anywhere]">
            {children}
          </code>
        );
      },
    }),
    // `[]` is correct even though the anchor now depends on the Space cwd: the
    // cwd is read by `OpenAnchor` from `SpaceCwdContext`, so the element created
    // here holds no cwd value and the map never goes stale. Adding `cwd` (or a
    // `useSpaceCwd()` call in this component) would rebuild the whole map — and
    // re-parse the markdown — on every Space change for nothing.
    [],
  );

  return (
    <div className="[overflow-wrap:anywhere] min-w-0 max-w-full text-ui-base leading-[1.75] tracking-wide [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      {/* `remark-gfm` is NOT included by default in react-markdown v10 —
       * without it GFM tables (and strikethrough / task lists) fall back to
       * raw pipe text, which is what made tables look broken in the chat. */}
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={components}
        urlTransform={safeUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
