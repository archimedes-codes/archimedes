# Counting code: the census instrument

Read this before quoting a `grep -c` count of anything in `src-tauri/`.

The **rules** these figures serve live in `AGENTS.md` (the poisoned-mutex
discriminator) and in `test-counts-and-splits.md` (test counts and splitting).
This file holds the arithmetic, the baseline reasoning, and — most importantly —
the ways one instrument disagrees with another.

**No count here is a target.** Each is correct only for the commit it was
measured at; the branch-vs-`main` baselines are recorded precisely to show that a
raw number is meaningless without a comparator.

## Poison recovery sites

The discriminator — recover when the lock guards independent per-key state, panic
when it guards one shared resource — is in `AGENTS.md`. The session registry is
the recovering case, and documents why in the comment block above its per-session
state accessors in `src-tauri/src/agent/session/mod.rs` ("a panic while holding a
registry lock must not wedge every later session read"). This is its census.

One map of independent per-session rows, **29 production recovery sites**
across `agent/session/`: `grep -rn "unwrap_or_else(|p| p.into_inner())" src-tauri/src/agent/session/
| grep -vE ':\s*//' | wc -l` → **41** call-site lines, of which **12** sit in test modules. Per file:
`session/mod.rs` **16** (all production), `naming.rs` **6** = 3 production + 3 inside its
`#[cfg(test)] mod tests`, `router.rs` **15** = 10 production + 5 inside its `#[cfg(test)] mod tests`,
`session/tests/mod.rs` **4** (test). Production = 16 + 3 + 10 = **29**. **Read the 41 as a LINE count, never as the production count** —
a reader who runs the command and stops at 41 will "correct" 29 to 41 and be wrong; the 12 to drop are
the ones inside `naming.rs`'s, `router.rs`'s and `session/tests/mod.rs`'s test modules, and only the per-file split
above says which. Use the comment-anchored filter, not `grep -v "//"`: the raw grep
prints **42** because a prose comment in `session/mod.rs` quotes the very pattern, and `grep -v "//"`
happens to give 41 today but would silently drop any real call site carrying a trailing `//` comment.
**These session figures are NOT this branch's drift — this branch touches `agent/session/` zero
times** (`git diff --stat <base>..HEAD -- src-tauri/src/agent/session/` prints nothing). The drift is
`main`'s and it is dated: at **`f1d9501f`** (2026-11-15) the same commands gave `mod.rs` **15**,
`naming.rs` **6**, `router.rs` **7**, `session/tests/mod.rs` **1** — anchored **29**, production **25**
— and the tree reached today's 41 / 29 at **`29beb578`** (2026-11-18), which is on `main` and an
ancestor of this branch's base. `naming.rs` is unchanged at 6 = 3 + 3 across the whole span. (An
earlier version of this paragraph attributed **+7** of that to this branch and called `f1d9501f`
"identical to `main`". Both are false: `f1d9501f` is not an ancestor of `main`, and the 12 anchored and
4 production lines between the two figures are `main`'s, not this branch's.)
The `storage/db/` unit panics with
`.expect("db mutex poisoned")` because `Db` holds ONE
`rusqlite::Connection` in a `StdMutex`
and a panic mid-transaction can leave that single connection unusable. **The unit is now a directory
(ADR 0113), so there is no single file to point the instrument at** — `src-tauri/src/storage/db.rs`
does not exist and a command naming it errors. Two spellings reproduce, and they differ by exactly
the per-file rationale headers, so name which one you ran. **The figures below are dated readings of
a moving target, not targets** — re-run both lines at your own HEAD before quoting either:

```sh
# raw, all siblings (measured 2026-11-24): 76
grep -rh 'expect("db mutex poisoned")' src-tauri/src/storage/db/*.rs | wc -l
# comment-anchored, the production figure (same day): 65
grep -rn 'expect("db mutex poisoned")' src-tauri/src/storage/db/*.rs | grep -vc '://'
```

The first is the shape this file exists to warn about: 11 of the 76 are the per-file
`// WHY THIS FILE PANICS ON A POISONED MUTEX` headers quoting the pattern, so the raw figure
over-counts by exactly those. **Read the filter's mechanism, not just its number** — `grep -v '://'`
works because `grep -n` prefixes every line with `path:NN:`, so a comment that begins with `//` at
column 0 contains the literal substring `://` and is dropped; a call site never can. That is also the
filter's limit: a quoted occurrence sitting in an INDENTED comment does not contain `://`, survives
the filter, and inflates the "production" figure — so the anchored number is *anchored*, not *proven
production*. The per-file split is what catches that, and it is why this file carries the split rather
than a bare total: **11** siblings hold a site —
`artifacts` 4, `auto_guards` 2, `board` 9, `messages` 8, `parent_link` 1, `retention` 5,
`sessions` 14, `spaces` 7, `stages` 8, `tasks` 4, `workflow_runs` 3, which sums to the 65.
Note too the path goes OUTSIDE the quotes — with it inside, the
pattern is a literal that matches nothing and the command prints **0** (verified: run it from
`src-tauri/` and pipe to `wc -l`). `src-tauri/src/storage/db/tests/`
holds the test-side set as a separate count in its own directory (measure it with the same two commands
pointed at `db/tests/*.rs`; there the two spellings agree, because no test file carries a header quoting
the pattern, and it read **61** earlier on 2026-11-24 and **66** later the same day while other work was
landing beside this one — which is the point of dating it), and the split is why the two sets are now in
different directories rather than one file. **Provenance for the figures this paragraph used to carry:** **51** and **52**
were both measured against the pre-split single-file `src-tauri/src/storage/db.rs`. That file no
longer exists anywhere in the tree, so **no command can re-run 51 or 52 any more** — 52 is what it held
at the revision immediately before the ADR 0113 split retired it, and that is recorded here as the
unreproducible reading it is, not as something to verify. **28** was the oldest and
**50** the base before `record_messages_batch` added one. The single-file era's 52 and today's 65 are
not a contradiction, they are two trees, and the gap is attributable by SYMBOL rather than by any
`main`-relative command (a `git grep … main --` reading of this would silently become a reading of
*this* tree the moment the branch squash-merges, which is why none is quoted): the `db/` directory
carried **58** anchored sites across **9** siblings before the auto-chain work, and the seven sites
this branch added are exactly the two siblings the workflow split created — `auto_guards` with **2**
and `workflow_runs` with **3** — plus **2** more in `stages` (`set_stage_auto`, `set_stage_prompt_prefix`).
A count
belongs in this file and nowhere in `AGENTS.md`, which is loaded on every task and now carries the
rule and the command instead of a number. **The asymmetry in the evidence has now closed, and it
closed because this bullet's own obligation was applied.** This bullet used to say the `db` unit
carries **no rationale anywhere in the file**, evidenced by `grep -n "poison" <the db file> |
grep -v 'expect("db mutex poisoned")'` printing nothing. **That grep now prints fifteen lines** (measured 2026-11-24, same day as the 65 above) — an
`// WHY THIS FILE PANICS ON A POISONED MUTEX` header in **each of the eleven siblings that hold a
site**, plus **four** prose lines that name the rule in passing: the rationale comment
`record_messages_batch` carries (`src-tauri/src/storage/db/messages.rs`), which
names this rule and says why that lock's resource is single and shared, a sibling's note that it moved
with its rationale intact, and two cross-references from `board.rs` and `parent_link.rs` that name the
rule in passing. So the "no rationale anywhere" evidence is
gone, and that is the intended outcome, not a regression: the sites still assert without arguing
individually, so a new file that opens one of these first still copies a bare panic. **The obligation
therefore stands unchanged: any NEW panic-on-poison site must carry a one-line rationale for
why its resource is single and shared** — `record_messages_batch` is now the in-repo example of what
that looks like (and it now carries an explicit **NO COUNT IS QUOTED HERE** note of its own, for
exactly the rot this file exists to catch), and the older sites are what it replaces. (Do not conflate
counts: the tree-wide
`grep -rn "into_inner()" src-tauri/src/ | wc -l` → **75** includes test modules and non-lock uses;
that is the
figure a review attributed to `agent/session/*`, which is a mis-attribution — `agent/session/`
itself holds **42** raw / **41** after dropping the comment line above, 29 of them production. Still
verify with the tree-wide command, since it is the one that reproduces. **This branch left the
tree-wide count unchanged:** it measures **75** at HEAD and **75** at the branch base, and no file's
`into_inner()` count moves between base and HEAD (checked per file across `src-tauri/src`), so there is
no delta here to attribute and none should be invented. **Provenance for the figures this parenthetical
used to carry:** **69** was exact at `eb5f7645`, the commit that wrote it, and the tree reached 74 at
**`29beb578`** (2026-11-18) — on `main`, and an ancestor of this branch's base. The deduction built on
it is **void and has been dropped**, not restated: it read "48 → 69, of which only the last 7 are ours
and 14 pre-date this branch", against a stated `main` baseline of **62**, and none of the three numbers
reproduces — `48` never appears anywhere in `main`'s history for this command (the values it takes are
0, 7, 15, 21, 37, 40, 51, 52, 54, 55, 56, 61, 62, 69, 74), `main` measures **74** today, and a baseline
of 62 cannot bound a gap between 48 and 69 that does not exist. A comparison whose base does not
reproduce is worse than no comparison, because it reads as verified.)

## `grep -c '#[cfg(unix)]'` counts LINES, including prose

- **`grep -c '#\[cfg(unix)\]'` counts LINES, including prose that names the
  attribute.** A census count needs the anchored `^#\[cfg(unix)\]$` or it
  false-reports high.
