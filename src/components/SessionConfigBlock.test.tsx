import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SessionConfigBlock from "./SessionConfigBlock";
import { useSessions } from "../store/sessions";
import { useModelCatalog } from "../store/modelCatalog";
import { useSettings } from "../store/settings";
import { resetStores } from "../test/resetStores";
import { setSessionConfigOption, type ModelDto } from "../lib/tauri";

/**
 * `SessionConfigBlock` — the Model / Reasoning / Context LINES.
 *
 * THIS FILE EXISTED NOWHERE BEFORE A5. The A5 plan asserted "component test file
 * exists in the components glob; update it for the new prop" — measured, there is
 * no `SessionConfigBlock.test.tsx` in the tree: the block's behaviour was pinned
 * from the OUTSIDE, through `SidePane.test.tsx` (the four-way fallback, the
 * always-enabled selectors, the ramp). So the block had no direct test of its
 * own, and the new `sessionId` prop is exactly the kind of prop a call-site test
 * cannot pin — `SidePane` never passes it.
 *
 * THE HAZARD THIS FILE EXISTS FOR. The block used to read `s.activeSessionId`
 * internally and nowhere else, so mounting it verbatim inside the New Task modal
 * would have rendered AND WRITTEN the globally-active Session's model and
 * thinking level while the user believed they were configuring a NEW one. The
 * `sessionId` prop is the fix, and the two directions of the fix need separate
 * pins:
 *   - the DEFAULT still keys off the global active session (`SidePane` passes
 *     no `sessionId` at all, so a regression here breaks the pane, not the
 *     modal), and
 *   - the OVERRIDE wins over the global one for BOTH reads and the write —
 *     "reads the right session" alone would pass with a picker that writes the
 *     wrong one, which is the half that loses data.
 *
 * Mocks follow `SidePane.test.tsx`'s recipe (the write path must be a mock, or
 * the write test pins a jsdom `invoke` rejection instead of the call). The
 * Model picker's ROWS come from the `useModelCatalog` store (#154), which
 * `resetStores()` deliberately does NOT cover — hence the explicit seed below.
 */
vi.mock("../lib/tauri", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("../lib/tauri");
  return {
    ...actual,
    // The write path. Un-mocked it reaches `invoke`, which rejects on jsdom's
    // missing `window.__TAURI_INTERNALS__`, so the isolation test would be
    // pinning a rejection rather than WHICH SESSION ID was written.
    setSessionConfigOption: vi.fn().mockResolvedValue([]),
  };
});

const CATALOG = "acme";

function catalogModel(id: string, provider = CATALOG): ModelDto {
  return {
    id,
    provider,
    contextWindow: 128_000,
    supportsThinking: false,
    thinkingLevels: [],
    supportsTools: true,
    selectable: true,
  };
}

/** A live Session row with the config options + usage the block renders. */
function seedSession(id: string, model: string, used: number): void {
  const existing = useSessions.getState().sessions;
  useSessions.setState({
    sessions: [
      ...existing.filter((s) => s.sessionId !== id),
      {
        sessionId: id,
        cwd: "/w/alpha",
        capabilities: {},
        archived: false,
        configOptions: [
          {
            id: "model",
            name: "Model",
            type: "select",
            currentValue: `${CATALOG}/${model}`,
            options: [
              { value: `${CATALOG}/${model}`, name: model },
              { value: `${CATALOG}/beta`, name: "beta" },
            ],
          },
        ],
      },
    ],
    configOptions: {
      ...useSessions.getState().configOptions,
      [id]: [
        {
          id: "model",
          name: "Model",
          type: "select",
          currentValue: `${CATALOG}/${model}`,
          options: [
            { value: `${CATALOG}/${model}`, name: model },
            { value: `${CATALOG}/beta`, name: "beta" },
          ],
        },
      ],
    },
    contextUsage: {
      ...useSessions.getState().contextUsage,
      [id]: { used, window: 128_000 },
    },
  });
}

/** Open the Model picker and click the named row.
 *
 *  Scoped to the picker's own dialog node: the trigger prints the CURRENT model
 *  name too, so a document-wide `getByText("beta")` matches twice whenever the
 *  session the trigger is reading is not the one the rows belong to — which is
 *  precisely the state the isolation cases construct. */
function pickModel(name: string): void {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  // READ SYNCHRONOUSLY, with no `await` between the two clicks. `await waitFor`
  // here would let the dialog-open update land outside an act scope (the
  // `not wrapped in act` warning) and would also mean the row click happens a
  // tick after the render it depends on. `SidePane.test.tsx`'s write-path case
  // reads the row the same way and is warning-free for exactly this reason.
  const dialog = document.querySelector(
    '[data-slot="dialog-content"]',
  ) as HTMLElement | null;
  if (!dialog) throw new Error("the model picker dialog did not open");
  const row = Array.from(dialog.querySelectorAll("[role=button]")).find(
    (el) => (el.textContent ?? "").startsWith(name),
  );
  if (!row) throw new Error(`no model row named ${name}`);
  fireEvent.click(row);
}

beforeEach(() => {
  resetStores();
  // The two stores `resetStores()` deliberately excludes / leaves unloaded —
  // the same reason `SidePane.test.tsx:105-118` hand-resets them.
  useModelCatalog.setState({
    models: [catalogModel("alpha"), catalogModel("beta")],
    loadStarted: true,
    loadedOk: true,
  });
  useSettings.setState({
    settings: { providers: [{ id: CATALOG, name: "acme" }] },
  } as never);
  vi.mocked(setSessionConfigOption).mockClear();
});

describe("SessionConfigBlock — the default is the global active Session", () => {
  it("with no sessionId prop, reads the ACTIVE session (SidePane's call site, unchanged)", () => {
    seedSession("s1", "alpha", 64_000);
    useSessions.setState({ activeSessionId: "s1" });
    render(<SessionConfigBlock />);
    // The trigger shows the ACTIVE session's model…
    expect(
      (screen.getByRole("button", { name: "Model" }).textContent ?? ""),
    ).toContain("alpha");
    // …and the context bar is the ACTIVE session's percentage (64000/128000 = 50).
    expect(
      screen.getByRole("progressbar", { name: "Context used" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("50");
  });

  it("writes the ACTIVE session when no sessionId is passed", async () => {
    seedSession("s1", "alpha", 64_000);
    useSessions.setState({ activeSessionId: "s1" });
    render(<SessionConfigBlock />);
    pickModel("beta");
    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith(
        "s1",
        "model",
        `${CATALOG}/beta`,
      ),
    );
  });
});

describe("SessionConfigBlock — sessionId overrides the global selection", () => {
  it("reads the NAMED session's model and context, not the globally-active one's", () => {
    // Two sessions that DISAGREE about everything the block prints. With the
    // hazard in place, both lines would come from `other`.
    seedSession("modal1", "alpha", 12_800); // 10 %
    seedSession("other", "beta", 115_200); // 90 %
    useSessions.setState({ activeSessionId: "other" });

    render(<SessionConfigBlock sessionId={"modal1"} />);

    const trigger = screen.getByRole("button", { name: "Model" });
    expect(trigger.textContent ?? "").toContain("alpha");
    expect(trigger.textContent ?? "").not.toContain("beta");
    expect(
      screen.getByRole("progressbar", { name: "Context used" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("10");
  });

  it("writes the NAMED session id, never the globally-active one (the half that loses data)", async () => {
    seedSession("modal1", "alpha", 12_800);
    seedSession("other", "beta", 115_200);
    useSessions.setState({ activeSessionId: "other" });

    render(<SessionConfigBlock sessionId={"modal1"} />);
    pickModel("beta");

    await waitFor(() =>
      expect(setSessionConfigOption).toHaveBeenCalledWith(
        "modal1",
        "model",
        `${CATALOG}/beta`,
      ),
    );
    // The negative half: the previously-active workspace Session was NOT touched.
    // Without this, a `targetId` that fell back to `activeSessionId` on the WRITE
    // path only would still satisfy the positive assertion above.
    expect(setSessionConfigOption).not.toHaveBeenCalledWith(
      "other",
      expect.anything(),
      expect.anything(),
    );
    expect(setSessionConfigOption).toHaveBeenCalledTimes(1);
  });

  it("null means NO target Session: the disabled stub, and no write path at all", async () => {
    // The value the New Task modal passes BEFORE its first send. `??` cannot
    // express this — `null ?? activeSessionId` hands a modal the workspace's
    // previously-active Session, which is the exact hazard the prop exists to
    // remove. So OMISSION means "the global active Session" (SidePane) and an
    // explicit `null` means "there is no Session yet".
    seedSession("other", "beta", 115_200);
    useSessions.setState({ activeSessionId: "other" });
    render(<SessionConfigBlock sessionId={null} />);
    // The ACTIVE session's model and its context bar must NOT show through: a
    // footer that prints `beta · acme` while the user picks a model for a Task
    // that has no Session yet is the same lie, wearing a different hat.
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.textContent ?? "").not.toContain("beta");
    expect(model.hasAttribute("disabled")).toBe(true);
    expect(
      screen.getByRole("progressbar", { name: "Context used" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("0");
  });

  it("an unknown sessionId renders the disabled Model stub (no config to write)", () => {
    seedSession("other", "beta", 115_200);
    useSessions.setState({ activeSessionId: "other" });
    render(<SessionConfigBlock sessionId={"ghost"} />);
    const model = screen.getByRole("button", { name: "Model" });
    expect(model.hasAttribute("disabled")).toBe(true);
    // The ACTIVE session's context bar does NOT leak in as a substitute — the
    // whole block keys off ONE id, not one line each.
    expect(
      screen.getByRole("progressbar", { name: "Context used" }).getAttribute(
        "aria-valuenow",
      ),
    ).toBe("0");
  });
});
