---
status: accepted
date: 2026-11-12
superseded-by:
---

# A **Palette** ships a reading per **mode**, a Palette with one reading pins that mode, and the default Palette is renamed `zai` → `default` with no alias

The Palette registry (`src/lib/palettes.ts`) replaces the `AppPalette` union and the four places that
had to be edited in step around it, and each entry declares `modes: readonly PaletteMode[]` — the
readings it ships. We decided three things at once, because they are one decision seen from three
sides: **a Palette ships a reading per mode, and the Theme setting is honoured only for the modes it
ships**; **a Palette whose `modes` list has exactly one entry pins that mode, `system` included** — the
pinning is a property of that Palette's data, not of the axis; and **the default Palette's id becomes
`default`, with no alias for the stored `"zai"`**, so a `settings.json` written before the rename holds
a value the registry does not recognise. The registry is `as const satisfies readonly
PaletteDefinition[]`, and `PaletteId` is derived from the literal's inference rather than written a
second time — a union of literals is the only place a typo'd palette value can be caught at compile
time, because the Rust side validates nothing.

**Why:** ADR 0027 bought the two axes so that a second reading of a scheme could "drop in without
re-touching the mode logic". That promise was unimplementable while dark-pinning was a
`palette === "dracula"` branch inside `resolveTheme` that ran *before* the mode was consulted: a
Palette could not declare anything, so nothing could enumerate it, and "dark-only" read as a rule about
palettes rather than as Dracula's own property. Measured consequences of the pre-registry shape, all
four re-verified for `docs/research/five-more-palettes-and-the-default-rename.md` §4: a third Palette
silently rendered `github-dark` code, the picker's save rule
(`onSave({ palette: value === "zai" ? null : "dracula" })`) wrote `"dracula"` for a third Palette's
selection, and the single-class invariant filtered over a hardcoded three-name array so a fourth class
was **invisible** to the gate that exists to catch two classes co-existing. `modes` is what turns the
promise into data: `paletteModeFor` answers with the Palette's own single mode when the requested one is
not shipped, so a Palette that ships one *light* reading pins light with no code change, and the CSS
class, the `.dark` toggle and `shikiThemeFor` all read the same resolution.

## Considered Options

- **Keep `modes` implicit — a Palette with no light reading is the one named in a branch.** Rejected:
  it is the status quo, and it is why "Dracula is dark-only" was written into the Settings row as
  though it were a law about palettes. The five Palettes this plan adds do not agree with each other
  about which modes exist, and a branch cannot be enumerated by a gate.
- **Alias the stored value: `serde(alias = "zai")`, or a `zai` → `default` fold in `load_settings`.**
  Rejected, and this is the option a reader is most likely to think is obviously correct. It would add
  a permanent vocabulary entry for a value no version of the app ever wrote *as a palette* except one
  (see the collision below), it keeps the `zai` string alive in the one file where that string means
  *model provider*, and it buys nothing: an unrecognised value already resolves to the default, by
  behaviour that was **executed** before it was written down.
- **Widen `applyThemeToDocument`'s palette parameter to `string`.** Rejected — it would silence the one
  tsc error in the registry sweep by deleting the only compile-time check a palette value gets. The
  sweep casts instead (`palette.id as PaletteId`), which is sound because the registry-enumeration gate
  pins `PALETTES.map(p => p.id)` to the exact literal list `PaletteId` is derived from.

## The hard drop is safe, and it was measured before it was decided

`paletteFor` routes any id the registry does not name to the default. That is not a convenience added
for the rename — it is the *measured* behaviour of the code the registry replaces. The research report
replicated `resolveTheme` + `applyThemeToDocument` verbatim and ran every palette value through it:

```
palette="zai"          resolved=zai-dark    classes=[dark, theme-zai-dark]
palette="dracula"      resolved=zai-dark    classes=[dark, theme-dracula]
palette="default"      resolved=zai-dark    classes=[dark, theme-zai-dark]
palette="tokyonight"   resolved=zai-dark    classes=[dark, theme-zai-dark]
palette=null           resolved=zai-dark    classes=[dark, theme-zai-dark]
```

`resolveTheme` read `palette` in exactly one place — the `=== "dracula"` guard — so `"tokyonight"` was
*indistinguishable from `null`* and the default's class was applied. Dropping `"zai"` from the
vocabulary therefore changes no rendering for the one user who has it. What the rename does is make
that accident explicit code, which is why it is now assertable: `theme.test.ts` ("routes an
unrecognised palette id to the Default palette (the measured fallback)") sweeps `"zai"` alongside
`"solarized"`, `""`, `"DEFAULT"`, `"Dracula"` and `"tokyonight"`, and `settings.test.ts` asserts the
same property through the DOM path.

**The residue, stated rather than smoothed over:** the picker only *renders* a fix.
`closedSelectValue` maps an unoffered value to the default's label so the trigger is never blank (Radix
renders nothing for an off-list value), and it is a rendering rule that never writes — so a stale
`"palette": "zai"` **survives in `settings.json` indefinitely** unless the user re-picks. The app looks
right and the file stays stale. That is accepted, on two grounds: the repo's precedent for folding a
renamed persisted value is ADR 0066's read-once fold plus `skip_serializing`, and `palette` has never
been validated in Rust (`Option<String>`, `#[serde(default)]`, zero branches on its value), so a fold
would be the first code in the backend that knows what a palette string means.

## The Z.AI collision — why nobody "finishes" this rename in Rust

**`"zai"` was not a made-up theme name that happened to collide with a provider id. It was the same
string.** `src-tauri/src/config.rs` `KNOWN_PROVIDERS` holds, at `:311`–`:322`:

```rust
id: "zai",      name: "Z.ai",      base_url: "https://api.z.ai/api/anthropic",  api: AnthropicMessages
id: "zai-api",  name: "Z.ai API",  base_url: "https://api.z.ai/api/paas/v4",    api: OpenAiCompletions
```

so a `sed -i s/zai/default/g` across the repo does not finish the branding removal — it **breaks model
access**, by rewriting the ids the Providers section resolves keys against. This is the specific thing
a future reader must not do, and it is the reason this rename was scoped to the theme vocabulary in the
frontend and never to the string.

What guards it:

- `src-tauri/src/commands/settings.rs` asserts the provider's URL by id:
  `assert_eq!(zai.base_url, "https://api.z.ai/api/anthropic")` — a Rust-side rename of the id fails
  that assertion, so the mistake is caught by `cargo test` rather than by a user who cannot reach a
  model.
- The frontend mirror is **6 lines** in `src/components/settings/SettingsPage.test.tsx` — the
  `listKnownProviders` fixture's two `Z.ai` entries (`name` / `baseUrl` / `keyUrl` × 2). Small enough
  that it will not be treated as a straggler to clean up, which is exactly the risk: a 6-line fixture
  *looks* like the debris of an unfinished rename. It is the provider catalog, mirrored per ADR 0024.
- `docs/decisions/0046`'s "the desktop's known-provider catalog is z.ai-shaped" is about providers, and
  stays true.

Nothing in `src/` production code names the provider through the theme vocabulary any more, and the
theme tokens never had a provider consumer — but the *string* is shared, and a text search cannot see
that. That is the whole reason this section exists in an ADR rather than in a commit message.

## Consequences

- **`"Dark-only"` is deleted as a property of the axis.** The Settings row now says the pinning is each
  palette's own choice. A Palette that ships both readings follows the mode and follows `system`;
  Dracula ships `modes: ["dark"]` and is inert under the Theme setting.
- **A Palette that ships one reading still declares the other mode's Shiki slot as `undefined`.**
  `shiki` is a total `Record<PaletteMode, string | undefined>`, so an unpublished reading degrades to
  `SHIKI_FALLBACK_THEME` rather than throwing inside `codeToHtml` — which the call sites' bare `catch`
  would render as plain text with a green suite. `paletteCompleteness.test.ts` now asserts the promise
  the registry's own comment makes ("every mode the registry declares SHOULD have an id … and
  `paletteCompleteness.test.ts` asserts it"): every mode a Palette *declares* must publish an id, and
  the fallback is pinned by name in the load list and in **both** highlighter singletons. Recorded
  honestly: today `SHIKI_FALLBACK_THEME` is `github-dark`, which is *also* the default Palette's dark
  id, so the load-list assertion is a tripwire for the day the fallback stops being a registry id
  rather than a mutation-detectable gate. The per-declared-mode assertion is the detectable half.
- **Every gate that enumerated classes or themes by hand is now a sweep over the registry** —
  `themeClassNames()`, `shikiThemeIds()`, `shikiThemesToLoad()`, the picker's options and its save rule
  (one expression over the registry, in `palettePicker.ts`). Registering a Palette therefore *extends*
  the gates instead of leaving them behind, which is the property all four measured failures lacked.
- **Class naming is uniform: `theme-<palette>-<mode>`.** So `.theme-dracula` became
  `.theme-dracula-dark`. These classes are applied at runtime from `theme.ts` and persisted nowhere, so
  neither rename costs compatibility — but any CSS, doc or test that greps for `.theme-dracula` as a
  *class* is now stale (the glossary's Identity-color entry was one, and is fixed alongside this ADR).
- **`PaletteId` is a union of literals and `PALETTES` is `readonly PaletteDefinition[]`, so a registry
  sweep sees `string`, not `PaletteId`.** That is the intended trade: consumers get a stable type and
  the derivation stays non-vacuous. Where a sweep must hand an id to a `PaletteId`-typed function it
  casts, and the cast is guarded by the registry-enumeration gate rather than by hope.
- **`docs/features/palettes.md` and ADR 0027's late amendment are the record of the rename's
  arithmetic**; this ADR holds the *policy* — per-mode readings, pinning as data, and the no-alias
  decision with its collision.
