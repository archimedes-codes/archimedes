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
| grep -vE ':\s*//' | wc -l` → **36** call-site lines, of which 7 sit in test modules. Per file:
`session/mod.rs` **16** (all production), `naming.rs` **6** = 3 production + 3 inside its
`#[cfg(test)] mod tests`, `router.rs` **11** = 10 production + 1 inside its `#[cfg(test)] mod tests`,
`session/tests/mod.rs` **3** (test). Production = 16 + 3 + 10 = **29**. **Read the 36 as a RAW line count, never as the production count** —
a reader who runs the command and stops at 36 will "correct" 29 to 36 and be wrong; the 7 to drop are
the ones inside `naming.rs`'s, `router.rs`'s and `session/tests/mod.rs`'s test modules, and only the per-file split
above says which. Use the comment-anchored filter, not `grep -v "//"`: the raw grep
prints **37** because a prose comment in `session/mod.rs` quotes the very pattern, and `grep -v "//"`
happens to give 36 today but would silently drop any real call site carrying a trailing `//` comment.
**These session figures are this branch's own drift, and it is bounded.** At `f1d9501f` — identical to
`main` — the same commands gave `mod.rs` **15**, `naming.rs` **6**, `router.rs` **7**, `session/tests/mod.rs`
**1**, anchored **29**, production **25**. This branch added **7** anchored lines: **4** production
(`mod.rs` +1, `router.rs` +3 — the issue #190 truncation flag's lock sites) and **3** test (`router.rs` +1,
`session/tests/mod.rs` +2). `naming.rs` is unchanged at 6 = 3 + 3.
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
`grep -rn "into_inner()" src-tauri/src/ | wc -l` → **69** includes test modules and non-lock uses;
that is the
figure the review attributed to `agent/session/*`, which is a mis-attribution — `agent/session/`
itself holds **37** raw / **36** after dropping the comment line above, 29 of them production. Still
verify with the tree-wide command, since it is the one that reproduces. That tree-wide figure moved
**40 → 48** on the branch that wrote this bullet, and every one of the 8 is in `src-tauri/src/storage/batching.rs` — the
per-session map the batching decorator adds, which recovers by design. **The rest of the drift since
is NOT this branch's, and the baseline matters:** `main` measures **62**, so of the **48 → 69** gap
only the last **7** are ours (the 4 production + 3 test session sites above) and **14 pre-date this
branch entirely** — writing "48 → 69" without the `main` = 62 baseline reads as though this branch
caused all of it.)

## `grep -c '#[cfg(unix)]'` counts LINES, including prose

- **`grep -c '#\[cfg(unix)\]'` counts LINES, including prose that names the
  attribute.** A census count needs the anchored `^#\[cfg(unix)\]$` or it
  false-reports high.
