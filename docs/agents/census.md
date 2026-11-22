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
`.expect("db mutex poisoned")` at **52 production sites** because `Db` holds ONE
`rusqlite::Connection` in a `StdMutex`
and a panic mid-transaction can leave that single connection unusable. **The unit is now a directory
(ADR 0113), so there is no single file to point the instrument at** — `src-tauri/src/storage/db.rs`
does not exist and a command naming it errors. Two spellings reproduce, and they differ by the 7
rationale headers, so name which one you ran:

```sh
# raw, all siblings: 59
grep -rh 'expect("db mutex poisoned")' src-tauri/src/storage/db/*.rs | wc -l
# comment-anchored, the production figure: 52 (drops 7 `//` lines that QUOTE the pattern)
grep -rn 'expect("db mutex poisoned")' src-tauri/src/storage/db/*.rs | grep -vc '://'
```

The first is the shape this file exists to warn about: 7 of the 59 are the per-file
`// WHY THIS FILE PANICS ON A POISONED MUTEX` headers quoting the pattern, so the raw figure
over-counts by exactly those. Note too the path goes OUTSIDE the quotes — with it inside, the
pattern is a literal that matches nothing and the command prints **0**. `src-tauri/src/storage/db/tests/`
holds 52 more, all test-side, and the split is why the two sets are now in different directories
rather than one file. **Provenance for the figures this paragraph used to carry:** **51** was measured
against the pre-split `src-tauri/src/storage/db.rs` (and `main`'s copy of it measures **52**, so that
figure was already one behind when it was written), **28** was the oldest and **50** the base before
`record_messages_batch` added one. **The asymmetry in the evidence has now closed, and it
closed because this bullet's own obligation was applied.** This bullet used to say the `db` unit
carries **no rationale anywhere in the file**, evidenced by `grep -n "poison" <the db file> |
grep -v 'expect("db mutex poisoned")'` printing nothing. **That grep now prints ten lines** — the
rationale comment `record_messages_batch` carries (`src-tauri/src/storage/db/messages.rs`), which
names this rule and says why that lock's resource is single and shared, plus a `WHY THIS FILE PANICS`
header in each of the seven siblings that inherited sites, plus three doc-comment lines that name the
rule in passing. So the "no rationale anywhere" evidence is
gone, and that is the intended outcome, not a regression: the 52 sites still assert without arguing
individually, so a new file that opens one of these first still copies a bare panic. **The obligation
therefore stands unchanged: any NEW panic-on-poison site must carry a one-line rationale for
why its resource is single and shared** — `record_messages_batch` is now the in-repo example of what
that looks like, and the 52 older sites are what it replaces. (Do not conflate counts: the tree-wide
`grep -rn "into_inner()" src-tauri/src/ | wc -l` → **74** includes test modules and non-lock uses;
that is the
figure a review attributed to `agent/session/*`, which is a mis-attribution — `agent/session/`
itself holds **42** raw / **41** after dropping the comment line above, 29 of them production. Still
verify with the tree-wide command, since it is the one that reproduces. **This branch left the
tree-wide count unchanged:** it measures **74** at HEAD and **74** at the branch base, and no file's
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
