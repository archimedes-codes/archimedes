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
});
