import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import WebSearchSection from "./WebSearchSection";
import { testSearchProvider, type AppSettings } from "@/lib/tauri";

vi.mock("@/lib/tauri", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tauri")>("@/lib/tauri");
  return {
    ...actual,
    testSearchProvider: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const mockSettings: AppSettings = {
  theme: "dark",
  palette: null,
  paneLayout: {},
  defaultTrustNewSpaces: false,
  defaultModel: null,
  defaultThinkingLevel: null,
  enabledTools: [],
  providers: [],
  mcpServers: {},
  font: { sizePx: 14, uiFamily: null, codeFamily: null },
  defaultThinkingLevels: {},
  agentOverrides: {},
  spinnerStyle: null,
  emptyStateAnimation: null,
  filePolicy: { reads: "allow", writes: "allow", shell: "allow" },
  web: {
    braveApiKey: "brave-secret",
    tavilyApiKey: "tavily-secret",
    perplexityApiKey: "perplexity-secret",
    keenableApiKey: "",
    searxngUrl: "http://localhost:8080",
    defaultProvider: "auto",
    proxy: "http://proxy.test:8080",
  },
  mcpMentionsEnabled: false,
  sessionNamingEnabled: true,
  sessionNamingModel: null,
  sessionNamingReasoning: null,
  attentionAlertsEnabled: true,
  attentionAlertDelaySecs: 15,
};

describe("WebSearchSection", () => {
  it("returns null when settings is null", () => {
    const { container } = render(
      <WebSearchSection settings={null} onSave={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders title, description, and all provider rows", () => {
    render(<WebSearchSection settings={mockSettings} onSave={vi.fn()} />);

    expect(screen.getByText("Web Search")).toBeTruthy();
    expect(
      screen.getByText(
        "Configure Search providers and proxy for web_search and fetch_content tools.",
      ),
    ).toBeTruthy();

    expect(screen.getByText("Brave Search")).toBeTruthy();
    expect(screen.getByText("Tavily")).toBeTruthy();
    expect(screen.getByText("Perplexity")).toBeTruthy();
    expect(screen.getByText("SearXNG")).toBeTruthy();
    expect(screen.getByText("Keenable")).toBeTruthy();
    expect(screen.getByText("DuckDuckGo")).toBeTruthy();
    expect(screen.getByText("Default provider")).toBeTruthy();
    expect(screen.getByText("Proxy")).toBeTruthy();
  });

  it("preserves other web fields when updating a field", () => {
    const onSave = vi.fn();
    render(<WebSearchSection settings={mockSettings} onSave={onSave} />);

    const braveInput = screen.getByLabelText("Brave API key");
    fireEvent.change(braveInput, { target: { value: "new-brave-key" } });
    fireEvent.blur(braveInput);

    expect(onSave).toHaveBeenCalledWith({
      web: {
        ...mockSettings.web,
        braveApiKey: "new-brave-key",
      },
    });
  });

  it("calls testSearchProvider and displays hit count on success", async () => {
    vi.mocked(testSearchProvider).mockResolvedValueOnce(5);
    render(<WebSearchSection settings={mockSettings} onSave={vi.fn()} />);

    const testBraveBtn = screen.getByLabelText("Test Brave Search");
    fireEvent.click(testBraveBtn);

    expect(testSearchProvider).toHaveBeenCalledWith("brave", mockSettings);

    await waitFor(() => {
      expect(screen.getByText("5 results")).toBeTruthy();
    });
  });

  it("calls testSearchProvider and displays error badge on failure", async () => {
    vi.mocked(testSearchProvider).mockRejectedValueOnce("Invalid API key 401");
    render(<WebSearchSection settings={mockSettings} onSave={vi.fn()} />);

    const testTavilyBtn = screen.getByLabelText("Test Tavily");
    fireEvent.click(testTavilyBtn);

    expect(testSearchProvider).toHaveBeenCalledWith("tavily", mockSettings);

    await waitFor(() => {
      const errorBadge = screen.getByText("error");
      expect(errorBadge).toBeTruthy();
      expect(errorBadge.getAttribute("title")).toBe("Invalid API key 401");
    });
  });

  it("supports testing Keenable", async () => {
    vi.mocked(testSearchProvider).mockResolvedValueOnce(7);
    render(<WebSearchSection settings={mockSettings} onSave={vi.fn()} />);

    const testKeenableBtn = screen.getByLabelText("Test Keenable");
    fireEvent.click(testKeenableBtn);

    expect(testSearchProvider).toHaveBeenCalledWith("keenable", mockSettings);

    await waitFor(() => {
      expect(screen.getByText("7 results")).toBeTruthy();
    });
  });

  it("renders a stored keenable default in the Default provider trigger", () => {
    // The Default-provider `Select` goes through `closedSelectValue`, whose
    // closed array is a SECOND copy of the provider vocabulary (the `SelectItem`
    // list above it is a separate copy). Drop a provider from that array and the
    // row still renders, its option still renders, and `getByText("Keenable")`
    // still finds it — but a user who has `defaultProvider: "keenable"` saved
    // silently reads "Auto (fallback order)" instead of what is actually active,
    // and because `closedSelectValue` never writes back, the file keeps the
    // value the UI denies. So the trigger itself is the only observable.
    render(
      <WebSearchSection
        settings={{
          ...mockSettings,
          web: {
            ...mockSettings.web,
            keenableApiKey: "keenable-secret",
            defaultProvider: "keenable",
          },
        }}
        onSave={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Default provider" });
    expect(
      trigger.querySelector("[data-slot=select-value]")?.textContent,
    ).toBe("Keenable");
  });

  it("supports testing DuckDuckGo (keyless)", async () => {
    vi.mocked(testSearchProvider).mockResolvedValueOnce(8);
    render(<WebSearchSection settings={mockSettings} onSave={vi.fn()} />);

    const testDdgBtn = screen.getByLabelText("Test DuckDuckGo");
    fireEvent.click(testDdgBtn);

    expect(testSearchProvider).toHaveBeenCalledWith("duckduckgo", mockSettings);

    await waitFor(() => {
      expect(screen.getByText("8 results")).toBeTruthy();
    });
  });

  it("renders exactly one configuration row per Search provider, each wired to its own field", async () => {
    // The row SET, pinned. `src-tauri/tests/search_provider_vocabulary.rs` joins
    // the provider vocabulary across the crate, the closed-select array and the
    // `<SelectItem>` menu, and its header says plainly that it is blind to the
    // configuration rows — a deleted or mis-wired row leaves the Rust pin green —
    // and the per-row tests above look each label up one at a time, so nothing
    // anywhere compared the SET of rows to the set of providers. This is that
    // comparison.
    //
    // What makes it bite rather than decorate: `KeyedProviderRow`'s `provider`
    // prop never reaches the DOM — it is only ever an argument to
    // `testSearchProvider` — so the Test button's call is what observes it, and
    // every provider gets a DISTINCT secret below so a row reading another
    // provider's `settings.web` field shows up as the wrong input value. Measured:
    // repointing the Keenable row's `apiKey` at `tavilyApiKey` fails here on the
    // input value, and repointing its `provider` prop at `"perplexity"` fails here
    // on the Test-button call.
    vi.mocked(testSearchProvider).mockResolvedValue(0);
    const settings: AppSettings = {
      ...mockSettings,
      // `keenableApiKey` is "" in `mockSettings`; filled so all five values are
      // distinguishable from one another.
      web: { ...mockSettings.web, keenableApiKey: "keenable-secret" },
    };
    const onSave = vi.fn();
    render(<WebSearchSection settings={settings} onSave={onSave} />);

    // Every configuration row carries exactly one `Test <label>` button, so those
    // buttons ARE the row set — read off the rendered DOM, not re-listed from the
    // source.
    const renderedRows = screen
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((label) => label.startsWith("Test "))
      .sort();
    expect(renderedRows).toEqual(
      PROVIDER_ROWS.map((row) => `Test ${row.label}`).sort(),
    );

    // Which `web` fields must be surfaced by a row: every field of the crate's
    // `WebSettings` except `defaultProvider` (the select) and `proxy` (a row of
    // its own, with no Test button). Derived from the object rather than re-listed,
    // so a provider added to `WebSettings` and given no row here fails this test
    // instead of joining the residue it is closing.
    const surfaced = PROVIDER_ROWS.flatMap((row) => row.field ?? []).sort();
    expect(surfaced).toEqual(
      (Object.keys(settings.web) as (keyof AppSettings["web"])[])
        .filter((field) => field !== "defaultProvider" && field !== "proxy")
        .sort(),
    );

    for (const row of PROVIDER_ROWS) {
      // The `provider` prop, observed through the IPC call it feeds — asserted
      // per row, so two rows claiming the same id cannot both pass.
      fireEvent.click(screen.getByLabelText(`Test ${row.label}`));
      await waitFor(() => {
        expect(testSearchProvider).toHaveBeenCalledWith(row.id, settings);
      });

      if (row.field === undefined) continue;

      // The READ binding: the input's value must be the field this row owns.
      const input = screen.getByLabelText(row.input) as HTMLInputElement;
      expect(input.value).toBe(settings.web[row.field]);

      // The WRITE binding: committing must patch THIS row's field and leave every
      // other `web` field at its stored value. The read alone does not catch a
      // mis-wired `onCommit` — measured, pointing the Keenable row's
      // `updateField("keenableApiKey", …)` at `"tavilyApiKey"` leaves the value
      // read correct and every assertion above green, so without this the type
      // still lets the row write another provider's credential.
      fireEvent.change(input, { target: { value: `committed-${row.id}` } });
      fireEvent.blur(input);
      expect(onSave).toHaveBeenCalledWith({
        web: {
          ...settings.web,
          [row.field]: `committed-${row.id}`,
        },
      });
      onSave.mockClear();
    }
  });
});

/// The provider configuration rows: the Search provider id each row must pass to
/// `testSearchProvider`, the label it must render, the input its key field must
/// reach, and the `WebSettings` field it must read. `id` is the one hand-copy here
/// — the crate's `SEARCH_PROVIDERS` is not nameable from TypeScript, and the Rust
/// pin is what joins these spellings to the wire; `field` is derived from the
/// settings object above rather than from this table.
const PROVIDER_ROWS: {
  id: string;
  label: string;
  input: string;
  field?: keyof AppSettings["web"];
}[] = [
  { id: "brave", label: "Brave Search", input: "Brave API key", field: "braveApiKey" },
  { id: "tavily", label: "Tavily", input: "Tavily API key", field: "tavilyApiKey" },
  {
    id: "perplexity",
    label: "Perplexity",
    input: "Perplexity API key",
    field: "perplexityApiKey",
  },
  { id: "searxng", label: "SearXNG", input: "SearXNG URL", field: "searxngUrl" },
  { id: "keenable", label: "Keenable", input: "Keenable API key", field: "keenableApiKey" },
  { id: "duckduckgo", label: "DuckDuckGo", input: "" },
];
