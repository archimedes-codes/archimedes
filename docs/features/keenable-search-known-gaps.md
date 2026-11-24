---
status: live
last-verified: 2026-11-24
verified-by: >-
  Written in one sitting at this branch's HEAD on 2026-11-24 (pre-squash, so no hash is quoted: a
  branch-only hash resolves nowhere after the squash-merge). Read in
  full: the crate at `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/fulcrum-harness-0.7.0/`
  (`web/config.rs`, `web/providers/keenable.rs`, `web/providers/registry.rs`, `web/providers/types.rs`,
  `web/net.rs`, `web/tools.rs`, `mcp/callback.rs`, `provider_auth/litellm_oauth.rs`,
  `provider_auth/cli_sso.rs`) and in this tree `AGENTS.md`, `src/components/settings/WebSearchSection.tsx`,
  `src-tauri/tests/fulcrum_seams.rs`, `src-tauri/src/config.rs`, `src-tauri/src/commands/settings.rs`,
  `src-tauri/src/agent/provider_auth/mod.rs`, `src/lib/toolOutput.ts`, `docs/features/mcp-known-gaps.md`,
  `docs/features/codemode-known-gaps.md`, `docs/features/litellm-provider-connections.md`,
  `docs/research/keenable-as-a-search-provider.md`. Re-measured here against the published 0.7.0 source:
  `SEARCH_PROVIDERS: [&str; 6]` and the `keenable_api_key` field, the `KEENABLE_API_KEY`-over-`web.keenableApiKey`
  layering and its `clear_web_env` removal, `AVAILABILITY_ORDER` with `keenable` at index 4, the
  `was_auto_resolved` gate and the `current_idx + 1..` walk, `is_available` as a `bool`, the request body
  (`query` / `max_results` / `snippet_max_length: 1000` / conditional `published_after`, no `mode`), the
  `X-API-Key` header, `x-api-key` in `strip_cross_origin_headers`, the nine `keenable.rs` tests (none of
  which names `disable_cards` or `cards.keenable`), and the fixed `json!` in `web/tools.rs` that has no
  `credits` slot. Re-measured in this tree: the privacy row's string, the `SelectItem` list versus the
  pinned closed-select array, `write_settings_atomic`'s mode preservation and its `#[cfg(unix)]` test, zero
  keychain/keyring hits in either repo, zero `credits_remaining` readers in `src/` and `src-tauri/src`, and
  that `CallbackServer` / `litellm_oauth::login` are both `pub` — in the CRATE (gap 7 corrects where they
  live). Re-checked against the vendor's live docs for the card-URL expiry, `disable_cards`,
  `unknown_parameter`, `/v1/search/public` and device login. CARRIED, not re-measured: every pricing,
  retention, ToS, benchmark and Stripe-auto-top-up number comes from the research doc's dated reading; the
  moved failover gap's account of WHO is affected is re-derived from source here, its reasoning is the
  previous fixer's. **What was and was not executed.** No *gap* below rests on a test run; the two scoped
  runs recorded at the end of this stamp corroborate the §4 pins and nothing else. As the
  gate for a `docs/`-only change, `TMPDIR=/home/daniel/tmp npx vitest run` over the four suites that read
  or quote `docs/` (67 passed) and `TMPDIR=/home/daniel/tmp pnpm build` (clean) were run in that sitting
  and both passed; they corroborate nothing written below. No authenticated Keenable call was made — the
  vendor claims were re-read from its published docs, which is the same instrument the research doc used.
  **Corrected in the follow-up to the commit that added this file:** the reason given there for the absence
  of any `cargo` run was false. `src-tauri` is a **workspace member** (`Cargo.toml`:
  `members = ["src-tauri"]`), so its artifacts land in the **root** `target/`, which is warm — a scoped
  `cargo test --test <name>` costs about a second once built, and the scoped runs recorded below are cheap
  rather than a cold full build. Both have been run at this sitting, and §4's two live `SelectItem`
  mutations were re-applied to the real `.tsx` and re-measured rather than read: each reddens
  `the_search_provider_vocabulary_agrees_across_the_crate_and_the_frontend` and leaves
  `npx vitest run src/components/settings/WebSearchSection.test.tsx` at 9 passed; the `.tsx` was restored
  byte-identically (sha256, `git diff -- src/` empty). The runs:
  `cargo test --test fulcrum_seams` → **22 passed / 0 failed / 0 ignored** (~1.1 s warm), and
  `cargo test --test search_provider_vocabulary` → **1 passed / 0 failed** (~0.8 s warm), the latter with
  its `include_str!` of `WebSearchSection.tsx` compiling and its four set comparisons green against the
  real frontend file. **Crate citations re-verified at this sitting:** every `file:line` citation
  above and every crate test name in this file was re-checked against the published 0.7.0 source. One test
  name was wrong and is fixed here — `parse_keenable_reads_snippet_not_description` does not exist; the
  real name is `parse_keenable_fixture_reads_snippet_not_description` (`web/providers/keenable.rs:351`).
  The other names hold (`parse_keenable_keeps_markdown_newlines` `:379`,
  `test_safe_fetch_redirect_and_cross_origin_header_stripping` `web/net.rs:480`,
  `test_resolve_provider_order` `web/providers/registry.rs:384`,
  `test_exec_web_search_explicit_provider_no_failover_wiremock` `web/tools.rs:573`), and so does every
  line citation, including `web/config.rs:19`/`:44`/`:102-103`/`:152`, `web/providers/registry.rs:16`/
  `:82`/`:158-160`/`:169`, `web/providers/keenable.rs:37-47`/`:93-99`/`:115`/`:140-149`/`:159-163`,
  `web/net.rs:119-124`, `web/tools.rs:171-179`/`:183-188`, `web/providers/types.rs:41` and
  `mcp/callback.rs:23`. The `keenable.rs` test count of **nine** also re-measures correct.
---

# Keenable Search provider — known gaps

Accepted, unfixed defects and deliberately-unbuilt scope in the **Search provider** line of work:
Keenable as the sixth entry in the `web_search` provider set, shipped across crate `fulcrum-harness`
**0.7.0** and this desktop. They live here because the plan and cards that recorded them are not in the
repo — per AGENTS.md a durable fact or accepted defect goes to `docs/features/` while the branch is
still open.

**Search provider, not provider.** Everything here is about the `web_search` backends. The bare word
**provider** in this repo means the model endpoint and belongs to `litellm-provider-connections.md` and
ADR 0014; `CONTEXT.md` and the crate's own `web/config.rs` doc-comment both forbid the short form for
this subject.

This file took over a gap that had been parked in
`docs/features/honest-turn-outcome-surfaces-known-gaps.md` §5 item 9 — see §2 — and it is the durable
home for the whole Search-provider surface, not only for Keenable. The vendor's capability set, pricing,
ToS position and quality benchmark are NOT restated here; they are the property of
`docs/research/keenable-as-a-search-provider.md`, which is a **dated, `status: retired` reading** — read
its "What changed since this reading (2026-11-24)" block before trusting anything in its body, because
its central recommendation was not taken and six of its values moved.

## 1. What shipped, so the gaps below have a floor

All of the crate-side lines below are the **published** `fulcrum-harness` 0.7.0, which is an immutable
line-numbered artifact (the one place the repo's no-`file:line` rule has an exception; the rule is in
`docs/agents/test-counts-and-splits.md` §"Citing and measuring", not AGENTS.md).

- **Keenable is the sixth Search provider.** `SEARCH_PROVIDERS: [&str; 6]` (`web/config.rs:19`) with
  `keenable` fifth; `WebSettings` carries `keenable_api_key` (`web/config.rs:44`), serialized as
  `keenableApiKey`. `AVAILABILITY_ORDER` (`web/providers/registry.rs:16`) is
  `["brave","tavily","perplexity","searxng","keenable","duckduckgo"]` — Keenable at **index 4**, the
  position research recommendation #1 asked for: keyed-before-keyless, so a Keenable failure falls
  through to the keyless rung.
- **Keyed-only.** `is_available` is `config.keenable_api_key.is_some()`
  (`web/providers/keenable.rs:115`). The keyless tier is not wired — §9.
- **`KEENABLE_API_KEY` layers over `web.keenableApiKey`** (`web/config.rs:102-103`), the same
  env-over-settings precedence as the other keys, and `clear_web_env` removes it
  (`web/config.rs:152`) so a developer's exported key cannot decide a crate test on one machine.
- **The request body is a wire contract, not a preference.** `web/providers/keenable.rs:140-149` sends
  exactly `query`, `max_results`, `snippet_max_length: 1000`, plus `published_after` when
  `recency_filter` maps (`day→1d`, `week→7d`, `month→30d`, `year→1y`, anything else dropped silently).
  `mode`, `session_id`, `objective` and tavily's `include_answer` are absent **on purpose**: this API
  hard-fails an unrecognised parameter with `400 unknown_parameter`, so exact body equality is how the
  provider's wiremock test asserts absence. `X-API-Key` carries the key (`:159-163`) with
  `Content-Type: application/json` enforced.
- **`snippet` is read, `description` never is.** `KeenableResultItem` (`web/providers/keenable.rs:37-47`)
  carries no `description` field at all and the parse reads `snippet` (`:97`). The vendor's
  OpenAPI marks `description` required and its prose says it is always the empty string — a port
  copying `brave.rs`'s `description` read returns an empty snippet for every result.
- **Markdown is preserved by deliberately NOT calling `clean_snippet`.** The shared helper collapses
  all whitespace, which destroys a Markdown table; Keenable's snippet is Markdown, so `parse_keenable`
  trims and passes through (`web/providers/keenable.rs:93-99`). Both deviations are commented at the
  top of the file and pinned — `parse_keenable_fixture_reads_snippet_not_description`
  (`web/providers/keenable.rs:351`) and `parse_keenable_keeps_markdown_newlines` (`:379`).
- **The `x-api-key` cross-origin strip shipped in the same release.** `strip_cross_origin_headers`
  (`web/net.rs:119-124`) removes `authorization`, `cookie`, `x-subscription-token` **and now
  `x-api-key`**. Before 0.7.0, `safe_fetch` followed redirects manually and re-sent the headers with
  only the first three stripped, so a redirect off `api.keenable.ai` would have forwarded the user's
  Keenable key to whatever host answered. Brave escaped only because its header name happened to be in
  the list; this was a latent hole for any provider authenticating by custom header, and the fix is why
  the function's doc-comment now says any such provider MUST add its header name here. The witness is
  `test_safe_fetch_redirect_and_cross_origin_header_stripping` (`web/net.rs`), which now asserts
  `x-api-key` is absent on the redirected request with the message
  `"x-api-key leaked across a cross-origin redirect"`.
- **Desktop side:** the Settings → **Web search** row (`provider="keenable"`, `keenableApiKey`) and the
  `keenable` option in the Default-provider select. See §6 for what that row says about logging.

## 2. Failover can route a failing provider INTO Keenable, which is metered, and nothing says it cost anything

*This item moved here on 2026-11-24 from `honest-turn-outcome-surfaces-known-gaps.md` §5 item 9, which
was where a previous fixer parked it because no Search-provider known-gaps file existed. That file's
subject is turn outcomes, not Search providers; the placement was defensible and it is now corrected.
Its substance is carried, with the `was_auto_resolved` gating re-derived from the 0.7.0 source rather
than trusted, and with one addition the original did not have (below: both halves of that gate are
already pinned in the crate).*

**The behaviour.** Keenable sits at **index 4** of `AVAILABILITY_ORDER` — immediately after all four
keyed providers, immediately before the keyless DuckDuckGo. The auto-failover arm takes
`AVAILABILITY_ORDER[current_idx + 1..]` and picks the first provider whose `is_available` holds
(`web/providers/registry.rs:162-172`). So for a user holding **brave + keenable**, an ordinary brave
`429` (or `402`/`500`) now fails over **into Keenable** — a per-credit paid API — where the same failure
previously dropped straight to free DuckDuckGo. Identically for **tavily + keenable**, **perplexity +
keenable** and **searxng + keenable**. The other half of the change was intended and is fine: a user
holding **only** a Keenable key now auto-resolves to Keenable rather than to scraped DDG.

**Who it affects, precisely — re-verified here, and the precision matters.** Only the `auto` path.
Failover is gated on `was_auto_resolved`, and the arm returns the original error immediately when that
flag is false (`web/providers/registry.rs:158-160`). `resolve_provider_from` sets the flag **only** on
the `AVAILABILITY_ORDER` walk (`:87`); an explicit `web.defaultProvider` (`:75`) or an explicit
`provider` argument on the tool call (`:64`) both return `was_auto_resolved: false` and their errors
propagate verbatim, with no failover at all. So the exposed population is **a user holding a Keenable
key plus any one of the four keyed providers, left on the default `auto`** — the ordinary configuration,
not an exotic one.

**Both halves of that gating are already pinned in the crate, so the gap is not an unverified reading
and it is not a test gap.** `test_resolve_provider_order` asserts `was_auto_resolved` true for the auto
walk and **false** for an explicit id, and `test_exec_web_search_explicit_provider_no_failover_wiremock`
drives the real tool with `provider: "brave"` against a mock brave returning `429` and a DuckDuckGo mock
mounted `.expect(0)`, then asserts the `[brave] error: HTTP 429` text comes back. So the shipped
behaviour is what is documented above, deliberately, and it is guarded. **What is not guarded — and what
this gap is — is that the auto arm's next provider may be a metered one.** Do not "fix" the gate to
close this: the gate is correct and pinned, and the fix belongs on the provider attribute described
below.

**Why it matters.** Keenable keys are entirely unscoped with no per-key spend cap, never expire, and can
sit above a Stripe auto top-up defaulting to a **$1,000/month** ceiling — research §F5, whose numbers
this file carries rather than re-measures. And `credits_remaining` is never surfaced (§7), so a brave
rate-limit — ordinary and expected, and used to be free — now spends the user's money invisibly. The
engine DOES report which provider answered, in the tool result's `details.provider`
(`web/tools.rs:185`), but nothing in `src/` reads that field (measured: no `details.provider` reader;
`toolOutput.ts`'s `web_search` arm reads `query` only), so no surface renders it.

**Deliberately not fixed, and why: the fix is a crate release, so it is out of this repo's reach.** The
right shape is a per-provider attribute on the `SearchProvider` trait — a "this one is paid / failover
may not enter it" flag the failover arm consults — so a metered provider can be auto-resolved as a
*first* choice but never *fallen into*. That also closes the **identical, pre-existing** edge for
**tavily** and **perplexity**, both keyed and both metered, which today can be fallen into from whatever
sits ahead of them; Keenable did not create this class of gap, it made the edge cheap enough to notice.
`AVAILABILITY_ORDER` is `pub` and its position was an approved decision, so re-ordering it desktop-side
is not the fix and was not attempted.

**Read the research doc's position-5 argument narrowly.** It argues position 5 is safe because it keeps
failover keyed-before-keyless, so a Keenable `429`/`402` degrades to DDG rather than to another **paid**
provider. True — and it argues **only Keenable's own forward edge**. It implies a failover-neutrality
for the other five that it does not establish, and it analyzes one direction of an edge that has two.
The dated correction block at the top of that file says so; read that block, not the dated body
sentence.

## 3. `cards.keenable.ai` result URLs expire after one day, and they are in the cache and in `get_search_content` today

**The highest-value item here, and the only one that is user-visible right now.** The vendor's own
Search API reference is explicit, in two places: a card is "a result Keenable writes itself for queries
such as prices, exchange rates or facts about a company, served at a URL like
`https://cards.keenable.ai/w/`", and **"A card URL works for one day"**; the `results[].url` field
entry repeats it — such a URL "stops working after one day". This is the vendor's claim, not ours; the
research doc carried it in its `SearchResultItem` mapping table and nothing in either repo contradicts
it. (Re-confirmed against the live docs on 2026-11-24.)

The shipped provider copies `results[].url` verbatim into `SearchResultItem.url`
(`web/providers/keenable.rs:42`, `:95`) with no filtering, so a card URL flows into the model-facing
`[title](url)` summary, into `ResponseCache`'s stored `json!({ "provider", "results" })`
(`web/tools.rs:171-179`) and into the `details.results` array (`web/tools.rs:187`), which is what
`get_search_content` pages from. A user who pages a search the next day, or who cites the link from a
session they left open, gets a dead URL — and the transcript keeps it permanently.

**Two options, both small, both deliberately out of scope for the shipping change because both alter
result content:**

1. **Send `disable_cards: true`** — one key in the request body. The vendor documents it exactly for
   this: "With `disable_cards`, ordinary web pages take the place of cards, so you still get the same
   number of results." Two things make this a change that needs its own test rather than a one-line
   edit: the API **hard-fails `400 unknown_parameter`** on a name it does not know (vendor error
   catalogue, `invalid_request_error`, not retryable), so a typo is a total outage of the provider
   rather than a degraded one; and `disable_cards: true` is documented to make `safety_mode`'s
   `moderate`/`strict` return `400 invalid_parameter` — a coupling to note if a safety mode is ever
   added. `disable_cards` is a real supported parameter (it appears in the vendor's own
   `unknown_parameter` example body's supported-parameter list), so the risk is a misspelling, not
   non-support. The existing wiremock test asserts **exact body equality** precisely to prove `mode` and
   friends are absent; a `disable_cards` change belongs **beside that test**, not inside it.
2. **Filter card URLs at parse** in `parse_keenable` — drops the affected results (fewer results than
   the user asked for) but needs no new request parameter and therefore no new failure mode.

Measured at 0.7.0: neither `disable_cards` nor `cards.keenable` appears anywhere in the crate's `src/`,
and no `keenable.rs` test names either — the handling does not exist in any form.

## 4. The `SelectItem` list was unpinned — CLOSED in-tree, plus the row set now pinned TS-side, and what neither closes

**CLOSED by `test(settings): extract the vocabulary pin, pin the SelectItem list, and clear the size
ratchet`.** Kept here as the record of the gap, of the shape of the fix, and of the residue the fix
deliberately leaves. The pin now lives in `src-tauri/tests/search_provider_vocabulary.rs` — extracted
out of `fulcrum_seams.rs`, whose subject is type identity across the seam, not this vocabulary.

**What the gap was.** The dropdown's `SelectItem` list is a separate literal in the same file from the
closed-select array and was not pinned at all. Verified by reading both: the array is one line inside
the `value={closedSelectValue(…)}` prop and the menu is a sibling block of seven hand-written
`<SelectItem value="…">` elements inside `<SelectContent>` — `auto`, `brave`, `tavily`, `perplexity`,
`searxng`, `keenable`, `duckduckgo`, i.e. `auto` plus the six `SEARCH_PROVIDERS`, so all seven carry a
`SelectItem` and none is missing one. They agree today, and nothing checked that they kept agreeing.
The concrete failure: a provider added to the array and not to the menu is a value the select will
happily hold — `closedSelectValue` accepts it, so the stored `defaultProvider` survives and renders —
while the user **cannot select or deselect it**, because no menu entry exists to click. The reverse (a
`SelectItem` whose value is missing from the array) is worse: `closedSelectValue` falls back to `"auto"`
for any value the array lacks, so the menu shows a provider as selectable, the click writes it, and the
row re-renders as "auto" — with `SEARCH_PROVIDERS` still accepting it on the wire, so it is a valid
stored value that the UI cannot display. **Every test stayed green in both cases** — measured, not
asserted: adding `<SelectItem value="exafunction">` and deleting the `brave` one each left
`npx vitest run src/components/settings/WebSearchSection.test.tsx` at 9 passed (re-measured at this
sitting; 8 before the row-set case was added) and left the then-current Rust pin passing too, because the
direction-1a whole-file containment assert
(`FRONTEND.contains("\"keenable\"")`) is satisfied by the `SelectItem` line itself naming the id. That
is exactly the hole the "parse, don't grep" reasoning left.

**The fix, and it is the same trick.** A `select_item_values` helper parses each `<SelectItem` element's
`value="…"` out of the same source text and the test asserts **set equality in both directions** against
the parsed closed-select array. No crate release is needed — it is a `src-tauri/tests/` edit. Proven to
bite against the real file: adding `<SelectItem value="exafunction">` fails the new direction-4 assert
naming `["exafunction"]`; deleting the `brave` `SelectItem` fails direction 3 naming `["brave"]`. The
`.tsx` was restored byte-identically (sha256 verified, `git diff -- src/` empty).

**What the closure still does NOT pin** — the residue, so a reader does not conclude the vocabulary is
fully guarded (the file's own header comment carries the same list):

- **In the Rust pin: the configuration ROWS, entirely.** `WebSearchSection.tsx` renders
  `KeyedProviderRow provider="brave" | "tavily" | "perplexity" | "keenable"` plus `SearxngRow` and
  `DuckDuckGoRow`, and nothing in `search_provider_vocabulary.rs` compares that set to
  `SEARCH_PROVIDERS`; the only assertion touching it is the cheap whole-file containment one, which a
  `SelectItem` alone already satisfies. Measured: with the whole `provider="keenable"` row deleted from
  the real file the Rust pin stays `ok`. That hole is closed on the TypeScript side, not here — see the
  next bullet.
- **The configuration row SET — now pinned, on the TS side.** `WebSearchSection.test.tsx`'s
  "renders exactly one configuration row per Search provider, each wired to its own field" case reads the
  row set off the rendered DOM (every row carries exactly one `Test <label>` button), asserts it equals
  the provider set, asserts each row's Test button calls `testSearchProvider` with its own id, and asserts
  each row both READS and WRITES its own `settings.web` field. `KeyedProviderRow`'s `provider` prop never
  reaches the DOM, so the IPC call is what observes it, and every provider gets a distinct secret so a
  cross-wired field shows up as a wrong input value. Proven to bite against the real file, four ways:
  pointing the Keenable row's `apiKey` at `tavilyApiKey` fails on the input value; pointing its
  `onCommit` at `"tavilyApiKey"` fails on the `onSave` patch; pointing its `provider` prop at
  `"perplexity"` fails on the Test-button call; deleting the row fails the row-set comparison. All four
  were re-measured at this sitting and the `.tsx` restored byte-identically each time. The set of fields
  the rows must surface is derived from the `web` object rather than re-listed, so a provider added to
  `WebSettings` and given no row fails this test instead of joining the residue below unnoticed.
- **The menu's labels and its `(not configured)` predicates** — still unpinned, by either side. Measured:
  changing the `keenable` `SelectItem`'s guard to read `settings.web.tavilyApiKey` leaves the Rust pin
  `ok` and the frontend suite at 9 passed. The row test pins which field a ROW reads; nothing pins which
  field a MENU ENTRY reads.
- **Order within the menu** — the comparison is a set comparison, since display order is cosmetic.
  (`AVAILABILITY_ORDER` vs `SEARCH_PROVIDERS` IS order-pinned, because there order is behaviour.)
- **Anything the Rust parse cannot see in source text.** `{/* … */}` spans are now stripped before both
  parses, which closes the false negative a commented-out element is to a text scan (measured: wrapping
  the `brave` `SelectItem` in `{/* … */}` used to leave the raw `<SelectItem` count at 7, the parse at the
  full set, the pin `ok` and the suite green; it now fails naming `["brave"]`, and so does
  `["auto", /* "brave", */ …]` in the array). Stripping comments is the boundary: a `value={expr}` that
  evaluates to a real id, a conditional `{cond && <SelectItem …>}`, or a menu built by mapping a hoisted
  array all read as what they textually are, not as what they render.
- **The sibling TypeScript implementation** — a different repo, reached by no `include_str!` here.

**What keeps the parse honest** (the failure mode of any source-text parse is reading nothing and
passing): the `unwrap_or_else` panics inside `select_item_values`, which NAME the offending tag — an
unclosed opening tag, a `value`-less `<SelectItem>`, an unterminated `value="` — the two non-emptiness
asserts that stop a vacuous set comparison, the exactly-one-`<SelectContent>` assert that stops a second
`Select` feeding unrelated values into the comparison, and the comment strip. There is deliberately NO
length-vs-occurrence-count assert: `select_item_values` iterates `match_indices("<SelectItem")`, so its
result length EQUALS that count by construction and such an assert could only ever fire from one of those
panics — measured, a `<SelectItem` → `<MenuItem` rename failed at the non-emptiness assert, not there. It
was billed as a guard, kept nothing honest, and is gone. Both parses stay wrap-agnostic — re-measured at
this sitting: a one-element-per-line reformat of the array plus a `SelectItem` re-wrapped across lines
with a second attribute parses identically and the pin stays green.

## 5. Keys live in plaintext `settings.json`, deliberately, and that is the highest-value structural follow-up

**The posture is a decision, not an oversight, and this item records it so a future reader does not
"discover" it as a bug.** There is **no keychain plumbing in either repo** — measured:
`grep -rni "keychain|keyring|secret-service|CredentialManagement"` returns nothing in this tree's
`src-tauri/src` or `src/` (the only hit anywhere near it is a crate doc-comment about sudo passwords
being in-memory-only, in `interactive/mod.rs`). `WebSettings` (`web/config.rs:40-51`) is a flat struct of
plain `String`s and every credential-shaped one of them sits in the settings document as plaintext:
`braveApiKey`, `tavilyApiKey`, `perplexityApiKey`, `keenableApiKey`, plus `searxngUrl` and `proxy` — the
four-key-plus-URL-plus-proxy surface the Settings → **Web search** section renders (`WebSettings` is
those four keys, `searxng_url`, `default_provider` and `proxy`).

The mode is **preserved by decision**: `write_settings_atomic` (`src-tauri/src/config.rs`) writes
through a `NamedTempFile` — which on unix is created `0600` — and copies the **existing file's mode**
onto the temp before `persist`, because letting the rename take the temp's mode would silently tighten
a user's `settings.json` from its configured mode (typically **0644**) to 0600. That silent mode change
is pinned by `write_settings_atomic_preserves_the_existing_files_mode_on_unix`, which seeds 0640 and
asserts 0640 comes back. It is `#[cfg(unix)]` — Windows has no mode concept, so nothing is pinned there
and the block is not even compiled.

**Why this is the item to fix:** Keenable keys are **entirely unscoped** (no read-only scope, no
per-endpoint restriction, no per-key spend cap, no TTL, no IP or origin allowlist — the only per-key
attribute is a free-text label), they **never expire**, and they can sit above a Stripe auto top-up
defaulting to **$1,000/month** on any account that can hold a card. So the blast radius of a leaked
`settings.json` is not "someone searched for things". That argument is research §F5's and is carried
here, not re-measured.

**Deliberately not fixed:** it is **one seam for every web credential at once, not a Keenable-specific
one** — a credential-store change under the settings document, which is exactly the shape that wants its
own design pass (and which the LiteLLM work already solved once for a different credential family:
`provider-auth.json` is created **0600**-at-creation with stage-then-rename, per
`litellm-provider-connections.md` §5). The precedent exists in this repo; what does not exist is a
decision to move `WebSettings` onto it, and doing it halfway for one provider would leave a document
with two confidentiality levels and no rule saying why.

## 6. Privacy posture is disclosed, not remediated

The Settings row now says what Keenable does. Its **current string**, read from the `provider="keenable"`
`KeyedProviderRow` in `src/components/settings/WebSearchSection.tsx` and quoted verbatim:

> `API key for Keenable Search API — Keenable logs queries with no fixed retention and may use them to train models.`

That is the whole of the app's privacy posture for this provider, and it is a **disclosure, not a
remediation**. Per research §F5: on the default data policy, keyed and keyless alike, Keenable logs the
query, the fetched URL, any fetch `prompt`, the results, IP, user agent and key/org ids, with **no fixed
retention period** (their docs say so twice), under a User Content license to use that content for its
AI models that is **perpetual and irrevocable**. **Zero-data-retention exists but is contract-only — the
console has no switch for it** — and it degrades function (`fetch` with a `prompt` returns
`400 zdr_prompt_unsupported`). So there is nothing the Settings row could offer beyond the sentence: no
toggle to build, no per-user setting to persist, no header to send. The vendor's own instruction is not
to send secrets or personal data in a query, a URL or a prompt.

**Deliberately not fixed because nothing here can fix it.** What remains open is a product judgement
this file cannot make: whether the sentence is prominent enough for a user population that reads "bring
your own key" as "keep your own privacy" — research's line is that it must **not** be read that way,
since an agent's search queries routinely carry private project details. ZDR is a commercial conversation
to have before GA, alongside the ToS written-confirmation the same section asks for. Neither is a code
change.

## 7. `credits_remaining` is never surfaced, so a metered-API user gets no spend signal

Keenable returns `usage.credits` and `usage.credits_remaining` on every successful keyed response, and
it is the one field a user of a per-credit API actually wants. It is nowhere in this product.

**Measured both sides.** In this tree: `grep -rn "credits_remaining" src/ src-tauri/src` returns **zero**
hits (the only `credits` match is an unrelated prose word in `src/lib/toolDetailsRegistry.test.ts`). In
the published crate: `grep -rn "credits" …/fulcrum-harness-0.7.0/src/` is likewise **zero** — the
provider's `KeenableResponse` struct parses `results` and nothing else
(`web/providers/keenable.rs:33-35`), so `usage` is discarded at parse, before anything could see it.

**Deliberately not fixed, and it is not fixable here:** `web_search`'s result is a fixed `json!` with no
room for it — `details: { responseId, provider, resultCount, results }` (`web/tools.rs:183-188`), and
the same fixed shape is what gets stored in `ResponseCache` (`web/tools.rs:175-178`). Surfacing spend
needs a crate change in two layers: parse `usage` in the provider, and give `web_search` somewhere to
put it. A `details` key is additive and would not break a consumer, but the parse and the emit are both
crate-side. Note the ordering trap: research contradiction **C4** records that `credits_remaining` is
documented in prose and present in live responses but **absent from the vendor's own OpenAPI `Usage`
schema** — treat it as optional, never assume it. Then it still needs a renderer decision: where a
credit count belongs in a tool card is a UI question nobody has answered.

## 8. Device login (RFC 8628) not adopted — paste-a-key only

Keenable's sanctioned answer to "a tool that can't show a sign-in page" is **device login**: request a
code, the user approves it in their console, the tool collects a new API key. Their docs describe it as
the flow for a CLI, a coding agent or a CI job, and research §F5 argues it is strictly better than a
paste field as the **primary** flow with paste as the fallback. The desktop ships paste only.

**The reuse claim, checked — and the claim as originally noted was mislocated.** A previous reading
pointed at `mcp::callback::CallbackServer` and a LiteLLM OAuth caller as evidence that the plumbing
exists. Both exist and both are `pub`; **neither is in the desktop**:

- `CallbackServer` is `pub` in the **crate** (`mcp/callback.rs:23`, with `pub async fn bind()`,
  `pub async fn bind_with(port, path)`, `pub fn redirect_uri()`, `pub async fn wait(…)`), reached from
  `fulcrum_harness::mcp::callback`. This tree has **no `src-tauri/src/mcp/` directory at all** — that
  module moved into the crate.
- The LiteLLM caller is real and lives beside it: `provider_auth/litellm_oauth.rs` calls
  `CallbackServer::bind_with(0, "/callback")` inside `pub async fn login(…)`, which this desktop calls
  through the re-export shell `src-tauri/src/agent/provider_auth/mod.rs` →
  `pub use fulcrum_harness::provider_auth::{… litellm_oauth …}` → `commands/settings.rs`'s
  `provider_login_oauth`. There is a second caller in `provider_auth/oidc.rs`, and `provider_auth/cli_sso.rs`
  carries a whole device-flow family (`start_device_flow`, `poll_once`, `choose_team`, `store_device_token`,
  `store_pasted`) plus the `SSO_POLL_INTERVAL` / TTL constants.

So the honest statement is **better than the original for the credential layer and worse for the
network layer**: the *shape* is proven in-repo — an additive `ProviderCredential` variant is a documented
cost (≈4 irrefutable-`let` bindings and ≈10 `ProviderConfig` literals, per
`litellm-provider-connections.md` §5), and the poll-and-store loop already has a working Rust analogue to
copy. But device login is a **Keenable-hosted** flow and every existing caller of `CallbackServer` is a
LiteLLM-proxy or MCP flow, so the desktop would be the first consumer of that `pub` API from outside the
crate — fine, it is `pub`, but the "it is already wired, reuse is nearly free" version of this claim is
not true and should not be repeated.

**Deliberately not fixed:** a plain `WebSettings` string field can hold a pasted key and nothing else.
A device flow yields a key the app must then store and refresh, which is the §5 credential-store gap in
another costume — and doing it before that store exists means putting a machine-minted key into a 0644
plaintext file, which is worse than asking a human to paste one they can see and revoke. Fix §5 first.

## 9. Keyless tier not adopted — and `is_available: bool` cannot express it

Keenable's headline offer is that search works without a key: `POST /v1/search/public` with an
`X-Keenable-Title` header naming the app, free and rate-limited **per IP** (research records
1,000 req/h/IP; the vendor's own docs confirm the endpoint, the header and that a key replaces "the
shared per-IP limit" with the org's own limit). The shipped provider requires a key: `is_available` is
`config.keenable_api_key.is_some()`, so an unconfigured user gets the error string, never the free tier.

**Deliberately not fixed, for two reasons, one structural and one that is not a technicality.**

- **Structural:** `is_available` returns a **`bool`** (`web/providers/types.rs:41`) and
  `AVAILABILITY_ORDER` is the only selection mechanism — there is no second list and no tri-state. A bool
  cannot say "available, but rate-limited and shared", so the honest options are a `bool` that lies or an
  enum change in the crate. The sibling TypeScript implementation hit exactly this and had to break its
  own abstraction to fix it: `isAvailable: () => true` forced a second provider list plus a test asserting
  that list "is never picked by the auto chain". Research §F7 records that, and records that position 6
  would buy the TS sibling's *behaviour* with no abstraction change — which is not what shipped, and is
  not the free *tier*.
- **The reason to be careful:** putting the keyless rung into `AVAILABILITY_ORDER` behind a bool that
  returns `true` for everyone would put **every unconfigured user behind one IP's hourly ceiling** — on a
  desktop app, that is the user's own residential IP, shared with everything else on their connection,
  and the failure mode is a `429` that looks like the app being broken. It is also a support surface the
  keyed providers do not have: the ceiling is not the user's, so no key of theirs can raise it. This is
  the product decision research labelled **C5** ("a product decision, not a research gap") and it is
  still open.
