---
status: current
last-verified: 2026-11-11
verified-by: hybrid research — 6 researcher angles (4 returned clean, 2 re-run after empty/garbled output) + 5 web sources per angle on the popularity/spec angles + local measurement at HEAD 55567ac6; the contested figures (block token counts, the unknown-palette fallback, the single-class gate, the ladder gate's scope, the Z.AI provider collision) were re-measured by hand by the orchestrator rather than accepted from a subagent
task: tsk_c9122343-a15e-4268-8e13-7cc0dff7d472
---

# Five more Palettes, and what renaming `zai` → `default` actually costs

> **Path note (2026-11-12, on ship).** Two lines below cite
> `docs/features/dracula-palette.md`, which was accurate when this report was written. That file was
> renamed to `docs/features/palettes.md` by the plan this report fed, because it stopped being one
> Palette's record once seven shipped. The citations are left as written — this report is a dated
> record of what was true at `55567ac6`, and rewriting its measurements to match a later tree would
> destroy exactly what makes them checkable.

**Settled question:** which 5 popular themes can the Client add as **Palettes** under ADR 0027's
mechanism — each with an official published colour spec AND a reusable Shiki theme, shipping a dark
AND a light reading wherever the theme publishes one — and what does renaming the default **Palette**
from `zai` to `default` (dropping the Z.ai branding, hard-renaming the persisted value, and re-tuning
its colours) touch?

**Gate decision taken during this research (2026-11-11):** the official-spec gate **stays**. The
Dracula precedent — transcribe only values the theme's own project publishes as documentation, and
allow-list the rest by name — outranks raw popularity, even though it costs the three most-installed
themes in the eligible ranking (One Dark Pro, Material Theme, Tokyo Night). Every recommendation
below is inside that gate.

---

## Executive summary

1. **The eligibility filter, not popularity, is the binding constraint.** Of ~22 candidates, 8
   plausibly clear both gates and only 5 clear them cleanly. The most-installed themes are not the
   spec-mature ones.
2. **"Both modes where the theme officially publishes one" is the expensive decision**, and it is
   what removes most of the famous names: Nord publishes no light product, Tokyo Night's light
   reading is not bundled in Shiki, and Monokai / Poimandres / Vesper / SynthWave '84 / Aurora X /
   Andromeeda / Red are dark-only with no transcribable spec at all.
3. **Four gates will silently accept a broken new Palette.** This is the highest-value finding,
   because it changes what "done" means: a naive implementation ships a palette that highlights with
   the wrong Shiki theme, saves the wrong `settings.json` value, and defeats ADR 0027's central
   invariant — all with a green suite. See *The four silent-pass gates*.
4. **`zai` is three identifiers and one live third-party collision.** It is simultaneously the
   `AppPalette` value, the `AppTheme` mode strings (`zai-light` / `zai-dark`), the CSS classes
   (`.theme-zai-*`) — **and** the Z.AI model **provider** id in `src-tauri/src/config.rs`, whose
   `base_url` is `https://api.z.ai/api/anthropic`. A blind rename breaks the provider catalog.
5. **The hard-rename fallback is TRUE, measured, not asserted.** An unknown `palette` string resolves
   to the default's class rather than to nothing, so the user sees the default app. What it does NOT
   do is clean the stale value off disk.

---

## Findings

### 1. The recommended five

Ranked by spec maturity × both-readings viability. Popularity is reported evidence, not the ranking
signal — see *Unresolved contradictions* §1 for why.

| Palette | Readings | Steps (dark / light) | Spec | Shiki pair | Installs / stars |
|---|---|---|---|---|---|
| **Catppuccin** | Mocha + Latte | 6 / 6, deliberately symmetric | [catppuccin.com/palette](https://catppuccin.com/palette) + machine-readable `palette.json` (hex/RGB/HSL/OKLCH) + a style guide + a "General Usage" section covering **non-editor UI** | `catppuccin-mocha` + `catppuccin-latte` | 1.49M VS · 2.24M JetBrains · **19,937★** |
| **Ayu** | dark + light (+ mirage) | 4 / 4, shape **enforced by the theme's own tests** | `ayu-theme/ayu-colors` `themes/*.yaml` — `surface.sunk/base/lift/over`, a per-hue 5-step OKLCH ramp, an ANSI table | `ayu-dark` + `ayu-light` | 4.25M VS · 862★ (palette repo) |
| **Rosé Pine** | main + dawn (+ moon) | 6 / 6, 15 roles × 3 variants | [rosepinetheme.com/palette](https://rosepinetheme.com/palette); the `rose-pine/palette` repo **emits CSS variables** and ships dawn as the `prefers-color-scheme: light` value | `rose-pine` + `rose-pine-dawn` | 350k VS · 1,634★ |
| **Kanagawa** | wave + lotus (+ dragon) | 6 / 6 (`bg_m3`→`bg_p2`) | `rebelot/kanagawa.nvim` — a **Name / Hex / Usage** table, and the only candidate besides Solarized publishing a **contrast clause: "colors maintain a 4.5:1 contrast ratio, complying with WCAG 2.1 Level AA"** — the same shape as Dracula's | `kanagawa-wave` + `kanagawa-lotus` | 290k VS · 6,449★ |
| **Everforest** | dark + light | **7 / 6** (light collapses `bg_dim` onto `bg2`) × 3 contrast levels | [palette.md](https://github.com/sainnhe/everforest/blob/master/palette.md) — every hex with a usage column, `bg_dim…bg5` + `bg_visual/red/yellow/green/blue/purple` | `everforest-dark` + `everforest-light` | 135k VS · 4,278★ |

**Catppuccin carries a free property no other candidate reproduces.** ADR 0096 chose Dracula's
`--color-card-border` seam `#21222c` because it is the exact per-channel midpoint of
`#191a21`↔`#282a36` **and** is itself spec-published. Testing every candidate for both properties:
Catppuccin Mocha's midpoint `#181825` (Mantle) is published. Every other candidate's midpoint is
invented. Verified by computation.

**Two of the five need a documented exemption, and Dracula already sets the precedent for both:**

- **Everforest** rejects **7 of our 25 `--color-file-*` identity hues** at the 3:1 glyph floor
  (`bg_dim #232A2E` and `bg1 #343F44` are too light for the dark blues). Since those hues must not be
  re-hued, the ladder has to move instead — the move `fileIconContrast.test.ts` calls `forbidden` in
  the other direction.
- **Ayu** publishes its foregrounds as 8-digit alpha (`#fcf8ecbd`); our gates match
  `^#[0-9a-f]{6}$`. De-alphaing drops the theme's own 74% weight, which its `AGENTS.md` says is
  deliberate ("text colors are translucent so they blend over any surface").

### 2. The exclusions, with reasons

- **One Dark Pro — #1 by popularity (12.9M VS installs, 11.8M JetBrains downloads) and the weakest
  spec in the set.** Atom's `one-*-syntax/colors.less` publishes **one background per mode**; the
  ladder exists only in two *different* VS Code repos (`Binaryify/OneDark-Pro` vs
  `akamud/vscode-theme-onelight`) at **222 dark UI tokens vs 74 light**. Its light reading is
  materially unfinished. Excluded by the gate decision above.
- **Material Theme (4.30M)** — best-in-set surface vocabulary (14 named roles, perfect dark/light
  mirror, 214 tokens each way), but `material-theme.com/docs/reference/color-palette` documents the
  **JetBrains plugin**, while Shiki's copies come from `antfu/vsc-material-theme`, an **archived** fork
  preserving commits the upstream deleted after the 2024 extension compromise. The palette docs and
  the bundled theme are not the same artifact and share no maintained owner — no permalink is
  authoritative for both.
- **Tokyo Night (3.02M)** — fails **both** gates. No palette documentation in either lineage, enkia's
  and folke's are *different palettes*, folke's light reading is **algorithmically generated**
  (`Util.invert(colors)` then `blend`), and `ls node_modules/shiki/dist/themes | grep tokyo` returns
  **one theme, dark** (verified locally).
- **Nord (1.30M, 6,913★)** — publishes exactly **4 background colours** (Polar Night), so filling our
  five roles means inventing a fifth shade, which is no longer Nord. No official light product, only
  "bright ambiance" prose. `#4c566a` is simultaneously its brightest surface, its comment colour and
  its only border candidate, at **1.69:1** — failing both floors.
- **Solarized (16,021★)** — the most rigorously specified palette here and structurally the least
  usable: **2 published backgrounds per reading**, with the other six monotones explicitly designated
  text ("please note that body text is not `base00`"). Its body text itself fails 4.5:1 on its own
  `base02` (4.11 dark, 4.13 light). All three status families fail in both readings.
- **Gruvbox (15,837★, 1.09M)** — an excellent 6-step ladder in both modes and the *only* candidate
  besides Night Owl whose own published border token clears 3:1 on all four surfaces, but the official
  palette is **a PNG in a README** (machine-readable hexes live in the community `gruvbox-contrib`)
  and `morhetz/gruvbox` carries **no LICENSE file**.
- **Night Owl (3.61M)** — feasibility-wise one of only two candidates needing **zero invented hexes**,
  and the only theme clearing all three status families *and* the 3:1 border on all four surfaces —
  but **no palette documentation exists at all** and every surface is anonymous.
- **Monokai Pro (4.20M)** and **SynthWave '84 (2.57M)** — the two biggest gate losses. Monokai Pro is
  closed and paid with no reachable palette page (`monokai.pro/{palette,filters,docs}` all 404); the
  classic Monokai Shiki bundles is Microsoft's internal VS Code folder with no spec.
- **Aurora X** — **GPL-3.0**, the only non-permissive licence in the set, and pure-AMOLED means two
  surface steps by design.

### 3. Three walls the current docs do not name

**The identity-hue tax is per-palette, not a differentiator.** Our 25 `--color-file-*` hues are
**Identity colors** (CONTEXT.md) that a Palette must not re-hue. Graded against each candidate's
surfaces at 3:1, **14 of 16 dark readings reject zero of them**; light readings reject heavily
(Catppuccin Latte 19, Kanagawa Lotus 20, Everforest Light 19, One Light 19, Gruvbox Light 24, Tokyo
Night Light 25). But **Dracula already pays exactly this tax** — it allow-lists 24 of 25 as off-spec
and restates all 25 vividly. Every new light Palette does the same work. It is authoring cost, not a
veto. The naive measure (how many hues does the theme publish) is what Dracula itself fails: 11 hues,
25 descriptors.

**The light ladder runs the wrong way for every theme.** `paletteCompleteness.test.ts`'s ladder
asserts each group is **strictly lighter** than the last, with `card-selected` brighter still — written
against Dracula's dark ladder per ADR 0096. In a light reading, every theme's own
`Base`/`editor.background` is its **lightest** published value, so `--color-background` cannot be the
theme's Base: Catppuccin Latte's page becomes `#acb0be`, not its `#eff1f5` Base. Nothing is invented;
the theme's own semantics are visibly overridden. **Decide this before authoring any light block** —
either the gate becomes direction-aware per Palette, or we accept and document the override.

**The alpha problem.** Catppuccin (selection = Overlay 2 at 20–30%), Rosé Pine (`#6e6a8633`),
Everforest (`#475258c0`), Horizon (a published alpha ramp `E6/B3/80/4D/1A/00`) and Ayu (throughout)
specify key UI colours as hex + alpha. Our spec gate matches `^#[0-9a-f]{6}$` and would reject the
transcription; a gate admitting `hex + alpha` has to say so. **This is a policy decision the plan must
make, not something research can resolve.**

### 4. The four silent-pass gates ⚠️

The deliverable, because each is a silent green rather than a red test.

| Gate | What it does today (verified) | What a sixth Palette does to it |
|---|---|---|
| `src/lib/theme.test.ts` — "exactly ONE `.theme-*` class, in every state" | `THEME_CLASSES` is a **filter over 3 hardcoded names** (`:210`); the matrix pins `MODES × PALETTES × OS_PREFS === 30` | A 4th class is **invisible to the filter**. Two palette classes co-applied still asserts `toEqual([expected])` and **passes**. ADR 0027's central invariant goes blind on the first new Palette — and the file's own doc-comment describes precisely this hazard ("dropping the `!dracula` guard … left 113 tests green"). |
| `paletteCompleteness.test.ts` — the elevation ladder | `LADDER`, the "not a plain hex" guard and the strictly-lighter loop all iterate **`DRACULA_VALUES`** only (verified) | A new Palette gets **no ladder grading at all**. The flat-step / elevation-inversion bug this test exists to catch is uncatchable in a new block. Same for `RAISED_FLOOR`, the off-spec allow-list, and the 4.5-ratchet exemptions — all Dracula-only. |
| `shikiThemeFor()` in `src/components/AgentMarkdown.tsx:110` | 2-arm ternary: `palette === "dracula" ? "dracula" : "github-dark"`; `CodemodeCard.tsx:117` inlines the same rule | A new Palette **silently renders `github-dark` code blocks**, and the 4 existing cases cover only `dracula` / `zai` / `null` / `undefined` — nothing notices. |
| `src/components/settings/AppearanceSection.tsx` — `onSave({ palette: value === "zai" ? null : "dracula" })` | A 2-arm save rule, correct only while the vocabulary is 2 wide | With 5 new Palettes, **selecting Catppuccin writes `"dracula"`**. A live bug in any naive implementation, not a theoretical gap. |

Additional silent-passes: the **block-order** gate compares byte offsets of a fixed name list, so a
sixth block placed *before `@theme`* (out-specifying everything) passes every ordering assertion;
`slabFloatSeparation.test.ts` has a 2-entry `PALETTES` table and only grades float shadows; and no test
anywhere enumerates `.theme-*` selectors by regex, `classList` or `querySelectorAll`.

**And the gates that DO fail loudly**, so the plan budgets for them: `paletteCompleteness.test.ts`'s
`INHERITED` set-equality in both directions (a new `.theme-zai-dark` token must be classified), the
`it.each(FILE_DESCRIPTORS)` completeness sweep, the block-order name list, `themeTokens.test.ts`'s
`RAMP_BLOCKS` and row-token tables, `theme.test.ts`'s `PALETTES` matrix and its `toBe(30)` coverage
pin, `fileIconContrast.test.ts`'s per-surface tables, `SettingsPage.test.tsx`'s Palette-row assertions,
`src/test/fixtures/settings.ts`, and `src/lib/cssSource.ts`'s documented cascade order.

### 5. Shiki: cheap to hold, with one paint trap

`shiki@4.4.3` (`package.json` devDependency, lock-pinned), **65 bundled themes**, every candidate
present — Tokyo Night's light reading is the sole exception.

- **Cost is negligible.** Measured on this machine: themes are **≈0.1 MB heap and ≈6 ms each**
  (12 themes = +1.3 MB / +13 ms; 24 = +2.5 MB). Language grammars cost **10–30× a theme**. All 65
  theme chunks are **already in `dist/`** today (310 chunks / 11.25 MiB raw, 65 of them themes), so
  adding bundled Palettes costs **0 new bytes on disk** — only runtime chunk fetches (~3.7 KiB gz each)
  and heap. ADR 0027's "one `createHighlighter` holds them all" scales fine to 12.
- **One instance holding many themes is safe** — verified by round-robin `codeToHtml` over 12 themes ×
  3 passes: 0 background mismatches. Caveat: `setTheme` mutates shared state, so an instance is **not**
  safe for interleaved *async* highlighting (irrelevant under the current synchronous-in-`.then` shape).
- **On-demand loading works but inherits the silent-fallback hazard.** `loadTheme()` then
  `codeToHtml()`; calling with an unloaded theme **throws**, and both call sites swallow it in a bare
  `catch { setHtml(null) }` (`AgentMarkdown.tsx:248`, `CodemodeCard.tsx:120`) → plain text, no signal.
- **The paint trap: what Shiki paints ≠ the theme's `editor.background`.** `normalizeTheme` prefers a
  global scope-less `tokenColor`, then falls back to VS Code's `#bbbbbb` / `#1e1e1e`. Verified by
  execution: **Ayu all three variants** emit `#0d1017` where the file says `#10141c` (and the official
  spec says `#0B0E14` — **two rungs off**, the worst spec-vs-code-block mismatch in the set);
  **SynthWave '84, Aurora X, Horizon, Horizon Bright** have no foreground and get generic `#bbbbbb`.
  **Derive the code-block surface from `highlighter.getTheme(id).bg` / `.fg` at runtime**, never from
  the spec page and never from `editor.background`.
- **Dual-theme output is the wrong tool here.** `themes: {light, dark}` is **1.45× HTML / 1.85× time at
  2 themes** (it tokenises once per theme), so a 7-Palette axis would need 10 CSS variables per token
  and ~10× tokenisation per render. It is right only for the **mode** axis. Note also that it
  multiplies inline `style` attributes, against the known `csp: null` constraint.
- **Licences are clean except one:** everything in the recommended five is MIT. `aurora-x` is GPL-3.0.
  Note the provenance caveat — Shiki's `solarized-*`, `monokai`, `red`, `dark-plus`, `light-plus` are
  Microsoft's re-licences inside `microsoft/vscode`, so transcribe from the *original* project's docs.

### 6. The rename, measured

**Inventory** — 353 `zai`-matching lines in `src/` (**278 in tests, 75 in production**), **13** in
`src-tauri/src/`, **60** in `docs/` + `README.md` + `CONTEXT.md`. Of the `src/` lines: **198** are
`zai-light`/`zai-dark` (the `AppTheme` values), **140** are `theme-zai-*` class strings, **41** are
bare `"zai"` literals. `AppTheme` is NOT persisted; `AppPalette` is. So a Palette rename drags the
`AppTheme` union and both CSS class names with it — decide whether those rename too, or the vocabulary
stays split-brained.

**MUST NOT RENAME — the live collision.** `src-tauri/src/config.rs` `KNOWN_PROVIDERS` holds, at
`:311-322`: `id: "zai"` / `name: "Z.ai"` / `base_url: "https://api.z.ai/api/anthropic"` /
`key_url: "https://z.ai/manage-apikey/apikey-list"`, and `id: "zai-api"` / `name: "Z.ai API"` /
`base_url: "https://api.z.ai/api/paas/v4"`. Mirrored in `src-tauri/src/commands/settings.rs:929`
(`assert_eq!(zai.base_url, "https://api.z.ai/api/anthropic")`) and in `SettingsPage.test.tsx`. **The
provider id and the Palette value are the same string** — a `sed s/zai/default/` reddens the provider
catalog. `docs/decisions/0046` also says "the desktop's known-provider catalog is z.ai-shaped", which
is about providers, not themes. **This is what "remove the z.ai branding" must NOT touch.**

**The fallback is TRUE — executed, not asserted.** Replicating `resolveTheme` +
`applyThemeToDocument` verbatim and running every palette value:

```
palette="zai"          resolved=zai-dark    classes=[dark, theme-zai-dark]
palette="dracula"      resolved=zai-dark    classes=[dark, theme-dracula]
palette="default"      resolved=zai-dark    classes=[dark, theme-zai-dark]
palette="tokyonight"   resolved=zai-dark    classes=[dark, theme-zai-dark]
palette=null           resolved=zai-dark    classes=[dark, theme-zai-dark]
```

`resolveTheme` reads `palette` in exactly one place (`theme.ts:29`, the `=== "dracula"` guard), so an
unknown value is indistinguishable from `null`/`undefined` and the default's class **is** applied. Two
residues: the picker (`closedSelectValue`) only **renders** the default label and never re-saves, so a
stale `"zai"` sits in `settings.json` permanently unless the user re-picks; and the `null` sentinel
means the default is an *absence*, so renaming the sentinel target from `"zai"` to `"default"` is
cosmetic in the file and permanent in the picker.

**Rust validates nothing.** `palette` is a free-form `Option<String>` with `#[serde(default)]`;
`grep -rn "serde(alias" src-tauri/src` → **0**. Precedent for a renamed persisted value is **ADR
0066's `subagentModels` → `agentOverrides`**: a hand-written read-once fold inside `load_settings`
guarded by "the new map is EMPTY", plus unconditional `skip_serializing` on the retired key. The other
pattern is in-place coercion of a blank value in `load_settings`. **A hard rename with no migration is
within precedent.** Traced-not-executed: `cargo test` was not run (workspace build cost).

**Re-tune surface** — re-measured at HEAD by brace-counting the resolved `index.css`:

```
@theme             185 declarations
.dark              149
.theme-zai-light   143
.theme-zai-dark    168
.theme-dracula     120   (54 inherited from zai-dark; +6 ramp tokens zai-dark does not declare)
dracula - zaiLight  31   (the 6 ramp + the 25 file-* descriptors)
dark - zaiLight      6   (exactly the ramp: --color-caution + --color-thinking-{low,medium,high,xhigh,max})
zaiLight - dark      0   (a strict subset — which is why .theme-zai-light must stay silent on the ramp)
dracula - dark      25
```

`.theme-zai-light` declares a **strict subset** of `.dark`, and the only `.dark` tokens it lacks are the
6 ramp tokens — consistent with `docs/css-theme-tokens.md`'s "the reason `.theme-zai-light` must stay
silent here". A light Palette must handle the ramp and the `--color-file-*` descriptors explicitly,
because `@theme`'s light-safe readings are what a classless document resolves.

**Two stale figures to correct while in there** (verified against the live gate):
`docs/features/dracula-palette.md:9` and `src/styles/dracula.css:5,155` both say **"115 declarations
(84 structural + 25 descriptors + 6 ramp), inheriting 59 of `.theme-zai-dark`'s 168"**. The live gate
says **"is 120 declarations: 89 structural + 25 descriptors + 6 ramp"** (`:475`) and **"inherits
exactly the 54"** (`:409`), and I independently measured **120 / 54 / 168**.

---

## Evidence

**Web (all fetched 2026-11-11):** VS Code Marketplace gallery API `extensionquery` (statistic
`install`) — note the documented `{"filters":{...}}` body shape is rejected, only the array form works;
GitHub REST via `gh api` (stars, licence); JetBrains `api/searchPlugins` (downloads); each theme's own
docs — `catppuccin.com/palette` + `catppuccin/docs/style-guide.md`, `rosepinetheme.com/palette` +
`rose-pine/palette`, `rebelot/kanagawa.nvim` README + `lua/kanagawa/{colors,themes}.lua`,
`sainnhe/everforest/palette.md`, `ayu-theme/ayu-colors`, `nordtheme.com/docs/colors-and-palettes`,
`ethanschoonover.com/solarized`, `material-theme.com/docs/reference/color-palette`,
`shikijs/textmate-grammars-themes` (the actual upstream Shiki re-distributes, with per-theme source
URL + licence).

**Local:** `src/lib/theme.ts`, `src/lib/settings.ts`, `src/lib/tauri/types.ts`, `src/lib/cssSource.ts`,
`src/styles/{theme,dracula,base,utilities}.css`, `src/index.css`, all five palette gates,
`src/components/AgentMarkdown.tsx`, `src/components/CodemodeCard.tsx`,
`src/components/settings/{AppearanceSection,primitives}.tsx`, `src-tauri/src/config.rs`,
`src-tauri/src/commands/settings.rs`, `node_modules/shiki` + `@shikijs/{themes,primitive}`, and this
repo's own built `dist/`.

**Credibility:** every hex, class list, token count and Shiki emission figure is measured locally by
execution or brace-counting; the popularity figures are raw API values with a date; the spec-maturity
judgements are read from each theme's own primary source. Where a figure came from a subagent and I did
not re-measure it, it is labelled below.

**Cite by content, not line.** Per this repo's own rule, the `:NNN` references above decay under
squash-merges; match on the assertion text (`"is 120 declarations: 89 structural + 25 descriptors + 6
ramp"`), the function name (`shikiThemeFor`), the string literal (`id: "zai"` beside
`api.z.ai`), or the `data-testid`, not the line number.

---

## Unresolved contradictions

1. **Popularity-vs-spec status for One Dark Pro, Material Theme and Night Owl.** One angle's ranking
   table marked all three `official-spec=full`; another read each primary source and documented why
   none has a transcribable spec (Atom publishes one background per mode; the Material docs and the
   bundled theme are different artifacts from different owners; Night Owl has no palette documentation
   at all). The first angle's own footnote says its spec column was carried from the second, so **the
   source-read wins**. The gate decision taken above makes this moot for selection, but it is the
   live tension: if popularity is ever weighted over spec purity, the honest move is to change the
   gate to "transcribe from the shipped VS Code theme JSON" and widen the allow-list the way Dracula
   did — not to keep the gate and quietly break it.
2. **"Zero invented hexes" vs "no published spec" — both true, for different sources.** The
   feasibility angle computed Tokyo Night and Night Owl as needing **zero** invented hexes (best of all
   28 readings) by reading their *theme files*; the spec angle found neither publishes a *specification*.
   Under the gate, "0 invented from the theme JSON" still means **every hex is off-spec**, i.e. a
   ~120-entry allow-list instead of Dracula's 24. That is the real price of the popular themes, stated
   plainly.
3. **Doc-drift finding, credible but not independently re-derived.** The feasibility angle reports that
   the "on the page" figures in `docs/features/dracula-palette.md` were measured against `#282a36`, the
   **pre-re-anchor** page, and are one rung optimistic across nine figures (`foreground 13.36`,
   `accent 5.90`, `FuncGreen 3.43`, `FuncRed 3.74`, `FuncOrange 4.66`, `icon-blue 7.60`,
   `destructive 5.23`, the ramp's `page 4.53 / input 5.03`), and that `#ff6e6e` on the page is quoted
   three different ways across two files (5.80 / 6.36 / 5.23). It reproduces the repo's published
   figures to the hundredth on every pair I could check, so I find it credible; I did not re-derive all
   nine. Direction is conservative (understates contrast) and **the gates recompute from the block, so
   they are correct** — this is doc drift, the same "count it, do not recall it" lesson recurring.
4. **Two floor values disagree, both live.** `slabFloatSeparation.test.ts` states "THE FLOOR IS 1.2,
   NOT 1.3, AND THAT IS A REAL CONCESSION" while `paletteCompleteness.test.ts`'s context-track
   commentary still reasons in terms of a 1.3 floor. Pre-existing; worth reconciling while both files
   are open.

---

## Gaps

- **No developer survey ranks themes.** "Most popular" here means **VS Code lifetime installs** —
  cumulative, not active users, structurally favouring old themes — with `trendMonth` (Microsoft's
  own score, formula unpublished) and GitHub stars as corrections. JetBrains figures are top-hit search
  results, several unofficial ports; treat as directional. `Material Theme UI` is a whole-IDE plugin,
  not a bare palette, and is not comparable.
- **Neovim adoption could not be quantified** — dotfyle's install ranking is client-rendered and its
  API was unreachable from the sandbox, so the nvim ordering is qualitative (star counts only). This
  matters more than usual for this app, whose users run terminal TUIs: Vim's own `colorschemes` tracker
  shows Monokai 6 variants, Solarized 6, Everforest 6, Nord 4, Kanagawa, Dracula 3, Horizon 3.
- **Monokai Pro Light is unverified and excluded from the ranking.** `monokai.pro` is a Svelte SPA
  exposing four hexes in its HTML; the extension is proprietary; the only reachable values are a third
  party's stated reverse-engineering. Classic Monokai's widely-republished hexes are **inferred**, not
  spec-quoted.
- **Solarized / Red / Andromeeda install counts are from the largest third-party port**, not an
  official extension (Solarized has no canonical VS Code extension, so its installs are fragmented
  across several ports; `Red` has no identifiable one; `Andromeeda` is a Zed theme whose nearest VS Code
  relative is EliverLara's *Andromeda*). All three are gate-blocked regardless.
- **`cargo test` was not run** (a second cold Rust build is not affordable on this machine), so the
  Rust findings are read from source and labelled traced-not-executed. The `dracula-was-here`
  round-trip assertion is quoted literally from `config.rs`; note it pins **helper freshness, not value
  tolerance**, and no equivalent test exists for `palette`.
- **Vesper publishes no light variant at all** — its `themes/` directory holds exactly one file,
  `Vesper-dark-color-theme.json`. Reported as a finding, not a gap.
- **Licence of the colour values themselves** was not obtained for `morhetz/gruvbox` (no LICENSE file),
  so the recommended five avoids it. Hex values are generally not copyrightable in most jurisdictions;
  this is a licence report, not legal advice.
- One angle left a scratch file `scripts/contrast-matrix.mjs` in the working tree; it was deleted and
  `git status` confirmed clean of it.
