import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import McpSection from "./McpSection";
import {
  authMcpServer,
  testMcpServer,
  type AppSettings,
  type McpServerEntry,
} from "@/lib/tauri";

// The `WebSearchSection.test.tsx` pattern: module-path mock of the barrel,
// spreading `importActual` so the value imports (`describeIpcError` rides in
// through `McpSection.tsx`'s direct `@/lib/ipcError` import, untouched) keep
// working, and overriding ONLY the two MCP commands this section calls.
vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    testMcpServer: vi.fn(),
    authMcpServer: vi.fn(),
  };
});

const mockedTest = vi.mocked(testMcpServer);
const mockedAuth = vi.mocked(authMcpServer);

/** The section's fixture: one OAuth HTTP entry + one plain HTTP entry. */
const settings: AppSettings = {
  theme: "dark",
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  defaultModel: null,
  defaultThinkingLevel: null,
  enabledTools: [],
  providers: [],
  mcpServers: {
    oauth_srv: { url: "https://auth.example/mcp", auth: "oauth" },
    plain: { url: "https://plain.example/mcp" },
    // A DISABLED entry, OAuth so BOTH action buttons render (Authenticate is
    // only rendered under `(isOAuth || needsAuth)`) — the only way the "both
    // buttons disabled" criterion below is actually exercised.
    off_srv: { url: "https://off.example/mcp", auth: "oauth", disabled: true },
    // A MALFORMED flag: the engine reads `disabled` through
    // `and_then(Value::as_bool) == Some(true)`, so a non-bool is NOT disabled.
    // The frontend must agree, hence `=== true` and not `!!entry.disabled`.
    sloppy: {
      url: "https://s.example/mcp",
      disabled: "yes",
    } as unknown as McpServerEntry,
  },
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
  emptyStateAnimation: null,
  filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
  web: {
    braveApiKey: "",
    tavilyApiKey: "",
    perplexityApiKey: "",
    keenableApiKey: "",
    searxngUrl: "",
    defaultProvider: "auto",
    proxy: "",
  },
  mcpMentionsEnabled: false,
  sessionNamingEnabled: true,
  sessionNamingModel: null,
  sessionNamingReasoning: null,
  attentionAlertsEnabled: true,
  attentionAlertDelaySecs: 15,
};

/** Render the section standalone — pure props, no store, no boot. */
function renderSection(): void {
  render(
    <McpSection
      settings={settings}
      dialog={null}
      setDialog={vi.fn()}
      onSave={vi.fn()}
      onRemove={vi.fn()}
    />,
  );
}

/** Click the row's Test button and wait for the test to have been called. */
async function clickTest(name: string): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: `Test MCP server ${name}` }));
  await vi.waitFor(() => expect(mockedTest).toHaveBeenCalled());
}

beforeEach(() => {
  mockedTest.mockReset();
  mockedAuth.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("McpSection (the MCP rows, ADR 0019)", () => {
  it("a successful test shows the tool count (the green contract)", async () => {
    mockedTest.mockResolvedValue(3);
    renderSection();
    await clickTest("plain");
    expect(await screen.findByText("3 tools")).toBeTruthy();
    // The one-shot test passes the entry as saved + the name (the page-level
    // pin lives in SettingsPage.test.tsx; this one proves the standalone mock
    // machinery drives the real row).
    expect(mockedTest).toHaveBeenCalledWith(
      { url: "https://plain.example/mcp" },
      "plain",
    );
  });

  it("a generic envelope failure shows the error badge and no Sign-in button", async () => {
    // The honest wire shape: test_mcp_server rejects with the SettingsError
    // envelope, `kind` mcp_test_failed, the sentence from Rust verbatim.
    mockedTest.mockRejectedValue({
      kind: "mcp_test_failed",
      message: "MCP server test failed: connect timed out",
    });
    renderSection();
    await clickTest("plain");
    expect(await screen.findByText("error")).toBeTruthy();
    // `plain` is not an OAuth entry and the sentence carries no auth marker —
    // the Sign-in button must NOT appear for it.
    expect(
      screen.queryByRole("button", { name: "Authenticate MCP server plain" }),
    ).toBeNull();
  });

  it("the CURRENT needs-auth contract: the marker inside the sentence shows the badge + Sign-in", async () => {
    // Today's truth, pinned: the 401-on-OAuth test rejects with the envelope
    // whose message is "MCP server test failed: needs-auth" (the thiserror
    // sentence around the raw marker `manager::test_server` propagates), and
    // McpSection decides on `error.includes("needs-auth")`. The badge reads
    // "needs auth" and the Sign-in button is offered.
    mockedTest.mockRejectedValue({
      kind: "mcp_test_failed",
      message: "MCP server test failed: needs-auth",
    });
    renderSection();
    await clickTest("oauth_srv");
    expect(await screen.findByText("needs auth")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Authenticate MCP server oauth_srv" }),
    ).toBeTruthy();
  });

  // blocked-on-task14/14c: SettingsError needs an auth kind (candidate
  // "needs_auth"); the wire today produces only "mcp_test_failed".
  //
  // This case was OBSERVED RED before it was parked (run first, no component
  // change): `TestingLibraryElementError: Unable to find an element with the
  // text: needs auth` — the badge reads "error", not "needs auth", because the
  // component discriminates on the SENTENCE (`includes("needs-auth")`) and
  // `kind` is
  // always `mcp_test_failed` — the envelope carries no machine discriminator
  // to switch on (the exhaustive-switch design is spec'd in the task14b plan;
  // it cannot be green until the Rust side adds the kind). A reword of the
  // Rust sentence therefore breaks this badge silently while the envelope
  // stays valid. Unblocking: task14/14c adds the SettingsError auth kind
  // (produced in commands/settings.rs by matching test_server's raw
  // "needs-auth" marker before the McpTestFailed wrap); then McpSection
  // branches on `kind` (the parked design), the McpTestErrorKind spellings gain
  // the frozen spelling in src-tauri/src/agent/errors.rs (the old TS-side mirror
  // src/lib/errors.ts was deleted — there is no union to extend here), and this
  // case un-skips green.
  it.skip("a reworded needs-auth sentence still shows the badge (the envelope-contract red-first)", async () => {
    // The ensure_connected-style reworded sentence (the agent path's wording)
    // inside a VALID envelope with a STABLE kind: the decision must ride the
    // machine discriminator, never the sentence.
    mockedTest.mockRejectedValue({
      kind: "mcp_test_failed",
      message:
        "MCP server test failed: the server requires authentication (use the `auth` action)",
    });
    renderSection();
    await clickTest("oauth_srv");
    expect(await screen.findByText("needs auth")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Authenticate MCP server oauth_srv" }),
    ).toBeTruthy();
  });
});

describe("McpSection: the per-server off-switch (`disabled`)", () => {
  // NOTE: this project has NO jest-dom and no `expect.extend` (documented in
  // `SessionsSection.test.tsx`, `PermissionsSection.test.tsx`, `SpacesList.test.tsx`,
  // `TaskDetailDialog.test.tsx`, `UpdateSection.test.tsx`), so `toBeDisabled()`
  // DOES NOT exist (TS2339 at `pnpm build`). Read the DOM property instead —
  // do not re-introduce the matcher.
  const isDisabled = (name: string): boolean =>
    (
      screen.getByRole("button", { name }) as HTMLButtonElement
    ).disabled;

  it("a disabled row badges Off, deadens Authenticate but lets Test ANSWER, and keeps Edit and Remove live", () => {
    renderSection();
    // The COUNT comes FIRST, on purpose: the `getByTitle` presence query below
    // throws `Found multiple elements` when a second Off badge appears, and that
    // accidental throw used to be the ONLY thing catching `!!entry.disabled` at
    // `McpSection.tsx:79`. Counting first makes the failure a deliberate length
    // assertion instead. `sloppy`'s malformed `"disabled": "yes"` must NOT
    // badge, so exactly one badge exists in the mounted section.
    expect(
      screen.getAllByTitle(
        "Off — this entry is not registered; a same-named server in a Space or user-level config still applies",
      ),
    ).toHaveLength(1);
    // Queried by title, NOT by text: `controls.tsx` already renders a label
    // "Off" elsewhere in Settings, so a text query collides the moment two
    // sections are mounted together.
    expect(
      screen.getByTitle(
        "Off — this entry is not registered; a same-named server in a Space or user-level config still applies",
      ),
    ).toBeTruthy();
    // And the single badge belongs to the `off_srv` row, NOT to `sloppy` — a
    // bare global count cannot tell those two apart, so the count is repeated
    // inside the row. `.border-t` (an exact class), NOT `[class*="border-t"]`:
    // the ghost buttons carry `border-transparent`, which that substring
    // selector matches.
    const offRow = screen
      .getByRole("button", { name: "Edit MCP server off_srv" })
      .closest(".border-t")!;
    expect(
      offRow.querySelectorAll(
        '[title="Off — this entry is not registered; a same-named server in a Space or user-level config still applies"]',
      ),
    ).toHaveLength(1);
    // Authenticate CANNOT work while the server is off (the entry is not
    // registered, and its flow is interactive — it opens a browser), so it
    // stays deadened.
    expect(isDisabled("Authenticate MCP server off_srv")).toBe(true);
    // Test ANSWERS instead of being deadened — the explicit human decision.
    // Disabling it made the honest sentence the Rust command produces
    // (`disabled_mcp_server_error` -> "this server is switched off — turn it
    // on to test it") unreachable from the UI: an inert button reports
    // nothing. Clicking it now reaches `test_mcp_server`, whose pre-check
    // fires before `classify_server` and before any connect, and the row
    // surfaces the sentence (pinned by the click test below).
    expect(isDisabled("Test MCP server off_srv")).toBe(false);
    // The negative half: Edit and Remove are the doors back ON and OUT. A
    // `disabled={isDisabled}` on either would lock the user out of their own
    // server, and the whole settings suite stays green if that happens — this
    // loop is the only thing standing between this task and that bug.
    for (const name of ["Edit", "Remove"]) {
      expect(isDisabled(`${name} MCP server off_srv`)).toBe(false);
    }
  });

  it("an ordinary row keeps its Test button enabled (the contrast pair)", () => {
    // Without this, the assertion above could pass vacuously (every button in
    // the file disabled, say).
    renderSection();
    expect(isDisabled("Test MCP server plain")).toBe(false);
    expect(isDisabled("Test MCP server oauth_srv")).toBe(false);
  });

  it("the off row's Test ANSWERS: the click reaches the command and the off sentence is shown", async () => {
    // This is the test that makes the human's decision real rather than a
    // predicate tweak: a switched-off row must EXPLAIN, not silently refuse.
    // The rejection below is the REAL wire shape, traced end to end:
    // `disabled_mcp_server_error` builds `SettingsError::Other`, its
    // `#[error("{0}")]` renders the sentence BARE, and `From<SettingsError>
    // for InvokeError` sends `{kind, message}` — so the message arrives as
    // the envelope's `message` and `describeIpcError` rule 3 returns it
    // VERBATIM (it chooses a string, it never re-writes one). The row then
    // renders `<SettingsBadge title={result.error}>error</SettingsBadge>`, so
    // the sentence reaches the DOM in the badge's `title` — the same place
    // the generic and needs-auth sentences go.
    mockedTest.mockRejectedValue({
      kind: "other",
      message: "this server is switched off — turn it on to test it",
    });
    renderSection();
    // The button must be clickable at all: on the previous component (Test
    // carried `isDisabled`) `fireEvent.click` on a disabled button never
    // reaches `onClick`, so this wait times out — the RED this test is meant
    // to produce.
    await clickTest("off_srv");
    // The UI no longer refuses locally: it ASKS the backend, passing the
    // entry as saved (`disabled: true` included) plus the name — which is
    // what lets Rust's pre-check produce the sentence in the first place.
    expect(mockedTest).toHaveBeenCalledWith(
      { url: "https://off.example/mcp", auth: "oauth", disabled: true },
      "off_srv",
    );
    // The off row shows the row's error badge. `findBy*` (not a bare `get`)
    // because `clickTest` waits only for the CALL; the rejection needs another
    // microtask flush before `setResult({ error })` lands (the same reason the
    // two error tests above use `findByText`).
    // `closest<HTMLElement>`: `within()` requires an `HTMLElement`, and the
    // bare `closest(".border-t")` the other tests here use yields `Element`
    // (they only call `querySelectorAll`, which `Element` has, so `tsc` is
    // happy there — it is not happy here).
    const offRow = screen
      .getByRole("button", { name: "Edit MCP server off_srv" })
      .closest<HTMLElement>(".border-t")!;
    expect(await within(offRow).findByText("error")).toBeTruthy();
    // ... and the badge carries the sentence VERBATIM (an equality assert, so
    // a generic re-word like "test failed" cannot pass it).
    expect(
      within(offRow).getByTitle(
        "this server is switched off — turn it on to test it",
      ),
    ).toBeTruthy();
    // Stated the way the card states it: the words "switched off" reach the
    // rendered output rather than a generic failure. The row renders the
    // sentence into the badge's `title` attribute (see above), so read the
    // row's titles, not its text content.
    const titles = Array.from(
      offRow.querySelectorAll("[title]"),
    ).map((el) => el.getAttribute("title") ?? "");
    expect(titles.some((t) => t.includes("switched off"))).toBe(true);
    // The Off badge survives the test result (it is not replaced by it).
    expect(
      offRow.querySelectorAll(
        '[title="Off — this entry is not registered; a same-named server in a Space or user-level config still applies"]',
      ),
    ).toHaveLength(1);
  });

  it("the edit dialog shows the off switch checked for a disabled draft", () => {
    // `renderSection()` passes `dialog={null}`, so this one passes the draft
    // directly (`McpDraft` is exported — no new export needed). This proves
    // ONLY the render wiring: the draft is hand-built here, so `entryToDraft`
    // and `draftToEntry` are pinned by the two round-trip tests below.
    // `useOAuth` is FALSE while `disabled` is TRUE on purpose: with both true,
    // `checked={draft.useOAuth}` would pass too and the assertion is a
    // tautology (measured upstream). The two booleans must differ.
    render(
      <McpSection
        settings={settings}
        dialog={{
          name: "off_srv",
          kind: "http",
          url: "https://off.example/mcp",
          headers: "",
          bearerTokenEnv: "",
          useOAuth: false,
          command: "",
          args: "",
          env: "",
          cwd: "",
          disabled: true,
        }}
        setDialog={vi.fn()}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(
      screen
        .getByRole("switch", { name: "Switch server off" })
        .getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("editing a row pre-fills the switch from the entry (and a non-bool reads as on)", () => {
    // `entryToDraft` is private, so the read is pinned through the row's own
    // Edit button: the draft the component hands the parent IS its output.
    const setDialog = vi.fn();
    render(
      <McpSection
        settings={settings}
        dialog={null}
        setDialog={setDialog}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit MCP server off_srv" }));
    expect(setDialog).toHaveBeenCalledWith(
      expect.objectContaining({ disabled: true }),
    );
    // The malformed `"disabled": "yes"` arrives as `false` — i.e. the server
    // stays ON, exactly as `classify_server` reads it
    // (`and_then(Value::as_bool) == Some(true)`). THIS assertion pins
    // `entryToDraft`'s `=== true` (`McpSection.tsx:244`); the Off-badge count in
    // the first test here pins the row's `=== true` (`McpSection.tsx:79`, which
    // drives the badge and the Test/Authenticate disabled state). TWO sites, two
    // pins — the comment here used to claim it was the only one, which was
    // wrong. The two must not diverge: a badge that disagrees with the pre-fill
    // tells the user two different things about the same server, so the
    // agreement itself is pinned by the next test.
    fireEvent.click(screen.getByRole("button", { name: "Edit MCP server sloppy" }));
    expect(setDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: false }),
    );
  });

  it("the badge and the pre-fill agree on the malformed flag (the two === true sites must not diverge)", () => {
    // `McpSection.tsx:79` and `McpSection.tsx:244` each spell `=== true` for
    // themselves — the row's badge/buttons and the edit dialog's pre-fill. Each
    // site has its own pin, but NOTHING pinned that they AGREE: a refactor could
    // flip one, leave every current query finding exactly one match, and the
    // suite would stay green while the UI contradicts itself. This test reads
    // BOTH surfaces for the SAME entry in one mount, so it fails if EITHER site
    // becomes `!!entry.disabled`: via the global badge count (the `:79` flip
    // badges `sloppy` too) or via the draft (the `:244` flip pre-fills the
    // switch as OFF for a server the engine keeps ON).
    const OFF_TITLE =
      "Off — this entry is not registered; a same-named server in a Space or user-level config still applies";
    const setDialog = vi.fn();
    render(
      <McpSection
        settings={settings}
        dialog={null}
        setDialog={setDialog}
        onSave={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    // Surface 1 — the badge. One badge in the whole section, and `sloppy`'s own
    // row carries none of it.
    expect(screen.getAllByTitle(OFF_TITLE)).toHaveLength(1);
    const sloppyRow = screen
      .getByRole("button", { name: "Edit MCP server sloppy" })
      .closest(".border-t")!;
    expect(sloppyRow.querySelectorAll(`[title="${OFF_TITLE}"]`)).toHaveLength(0);
    // `sloppy` is ON, so its actions stay live — the `:79` site again, read
    // through the button rather than the badge.
    expect(
      (screen.getByRole("button", { name: "Test MCP server sloppy" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    // Surface 2 — the edit pre-fill for the SAME entry.
    fireEvent.click(screen.getByRole("button", { name: "Edit MCP server sloppy" }));
    expect(setDialog).toHaveBeenLastCalledWith(
      expect.objectContaining({ disabled: false }),
    );
  });

  it("saving omits the key when the switch is off and writes `disabled: true` when on", () => {
    // `draftToEntry` is private, so the write is pinned through `onSave`'s
    // second argument. NOTE: no `rerender()` here — `McpDialog` does
    // `useState(initial)`, so it copies the prop ONCE and a re-render with a
    // new `dialog` prop cannot reach the dialog's internal draft; the second
    // Save would silently re-submit the unchecked one. Clicking the switch is
    // also the only thing that pins `onCheckedChange`.
    const onSave = vi.fn();
    const draft = {
      name: "n",
      kind: "http" as const,
      url: "https://n/mcp",
      headers: "",
      bearerTokenEnv: "",
      useOAuth: false,
      command: "",
      args: "",
      env: "",
      cwd: "",
      disabled: false,
    };
    render(
      <McpSection
        settings={settings}
        dialog={draft}
        setDialog={vi.fn()}
        onSave={onSave}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    // The whole-object form: `{url}` with NO `disabled` key. `draftToEntry`'s
    // contract is that empty fields are OMITTED, and `SettingsPage.test.tsx`
    // asserts saved entries with `toEqual` on the WHOLE object.
    expect(onSave).toHaveBeenLastCalledWith("n", { url: "https://n/mcp" });
    fireEvent.click(screen.getByRole("switch", { name: "Switch server off" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenLastCalledWith("n", {
      url: "https://n/mcp",
      disabled: true,
    });

    // The stdio half. Nothing else in the repository builds an stdio draft
    // with `disabled: true`, so without this block, moving the write INSIDE
    // the `kind === "http"` branch — the exact defect this task's design note
    // exists to prevent — leaves the whole suite and `tsc` green (measured
    // upstream).
    cleanup();
    const onSaveStdio = vi.fn();
    render(
      <McpSection
        settings={settings}
        dialog={{
          name: "n",
          kind: "stdio",
          url: "",
          headers: "",
          bearerTokenEnv: "",
          useOAuth: false,
          command: "npx",
          args: "",
          env: "",
          cwd: "",
          disabled: true,
        }}
        setDialog={vi.fn()}
        onSave={onSaveStdio}
        onRemove={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSaveStdio).toHaveBeenLastCalledWith("n", {
      command: "npx",
      disabled: true,
    });
  });
});
