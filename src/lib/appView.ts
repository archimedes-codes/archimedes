/**
 * `App`'s content-area **view union** — the ONE declaration of it.
 *
 * ## Why this module exists and what it deliberately is not
 *
 * The union used to be spelled in three production places (`App.tsx`'s `view`
 * `useState`, `hooks/useAttentionAlertClick.ts`'s local `AppView`, and
 * `SpacesList.tsx`'s `currentView` prop) plus one deliberate fixture
 * (`hooks/useAttentionAlertClick.test.ts`, which keeps its own copy on purpose —
 * see that file). The hook's comment justified the duplication by saying a shared
 * type "would have to live in a third module that only these two read", because
 * "`App` imports this hook". That is not how type edges work: `App.tsx` already
 * imports the hook, so `import type { AppView }` from a module the hook also
 * imports adds no edge to `App`'s graph at all — and with
 * `verbatimModuleSyntax` a type-only import compiles to nothing, so it cannot add
 * a runtime edge to anyone's graph.
 *
 * So this file is that third module, and it is the smallest thing that can hold
 * the union: a pure type, no store, no components, no runtime import of any kind.
 * `src/lib/layerBoundary.test.ts` forbids a `lib/` module RUNTIME-importing
 * `store/` or `components/`, and a file with zero imports satisfies it by
 * construction — the direction that matters here is the one that cannot be
 * violated, since a `store/` module (`taskLaunch`) and a `components/` module
 * (`SpacesList`) both read this union and neither may be read BY a `lib` module.
 *
 * ## What sharing it does NOT buy, and why the pins stay
 *
 * A shared union makes the three spellings one spelling; it does not make a
 * widening safe. `App`'s ternary keeps the workspace as its implicit `else`, so a
 * new arm added to the union and not to the ternary paints the chat column and the
 * Side pane with a green build — `App.test.tsx`'s per-arm cases are what catch
 * that, and they are per-arm for the reason `App.tsx` records. And
 * `SpacesList`'s `currentView` is a prop whose call sites all pass a literal, so
 * widening the union WITHOUT adding the door is not a `tsc` error at all:
 * `SpacesList.workflows.test.tsx`'s `aria-pressed` case is the only thing that
 * catches a view the pane can be TOLD about but cannot name. Both pins still earn
 * their place; only the restatements are gone.
 */
export type AppView = "workspace" | "settings" | "board" | "workflows";
