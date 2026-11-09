import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { MenuPanel } from "./MenuPanel";

/**
 * The class STRING via the ATTRIBUTE, not `el.className` — the property is an
 * `SVGAnimatedString` for SVG elements, so reading it is only safe on HTML
 * elements (`MutedCaption.test.tsx` / `IpcErrorLine.test.tsx` carry the same
 * note). `MenuPanel` renders a `div` today, but this is a LAYOUT shell and the
 * reader that is correct for both elements costs nothing.
 */
function classOf(el: Element): string {
  return el.getAttribute("class") ?? "";
}

/**
 * The shell's own root: the FIRST element under the render container, and
 * asserted to be a `div` — the "no landmark" test depends on there being no
 * other element to mistake for one.
 */
function island(container: HTMLElement): HTMLElement {
  const root = container.firstElementChild as HTMLElement;
  expect(root.tagName).toBe("DIV");
  return root;
}

/**
 * THIS FILE HAS NO MOCKS AND MUST NOT GAIN ANY.
 *
 * `MenuPanel` renders a plain `div` and touches no IPC, so nothing here imports
 * `@/lib/tauri` and nothing calls `vi.mock`. That is not an oversight to
 * "correct" by following the neighbouring component tests' house pattern:
 * `tauriBarrel.test.ts` pins the SET of barrel-mocking test files by identity at
 * a fixed length, so a mocker added here reddens a scanner this change does not
 * otherwise touch.
 */
describe("MenuPanel (the flanking island shell — ADR 0097)", () => {
  it("wears the island recipe: m-1 + rounded-xl on the content plane", () => {
    const { container } = render(
      <MenuPanel width={268}>
        <span>nav-content</span>
      </MenuPanel>,
    );
    // Asserted as WHOLE TOKENS (a substring match would let `m-12` or
    // `rounded-x` through). `m-1` is the 4px frame gap between two islands — two
    // facing `m-1`s make the 8px gutter that used to be a `border-r` — and
    // `rounded-xl` is what makes the surface read as an island rather than as a
    // column.
    const tokens = classOf(island(container)).split(/\s+/);
    expect(tokens).toContain("m-1");
    expect(tokens).toContain("rounded-xl");
    expect(tokens).toContain("relative");
    expect(tokens).toContain("flex");
    expect(tokens).toContain("shrink-0");
    expect(tokens).toContain("flex-col");
    expect(tokens).toContain("overflow-hidden");
  });

  it("fills the ISLAND step (bg-chat), never the chrome step (bg-frame)", () => {
    // ADR 0097: `bg-frame` is CHROME — the titlebar and the Session list. The
    // Menu panel floats ABOVE that plane; painting it `bg-frame` would drop it
    // into the pane to its left, which is the exact defect this shell exists to
    // remove (Settings' nav sat on the frame colour at a contrast of 1.00).
    const { container } = render(
      <MenuPanel width={268}>
        <span>island-fill</span>
      </MenuPanel>,
    );
    const tokens = classOf(island(container)).split(/\s+/);
    expect(tokens).toContain("bg-chat");
    expect(tokens).not.toContain("bg-frame");
  });

  it("says bg-chat and NOT bg-inspector — a token that names a side is a lie in a mirrorable shell", () => {
    // `--color-inspector: var(--color-chat)` in all four palette blocks, so the
    // two are the SAME colour and swapping them is invisible to the eye. The
    // reason to refuse it anyway is vocabulary: "inspector" is the right-hand
    // **Side pane**, and this shell's whole purpose is being that geometry
    // mirrored to the LEFT. A reader inside `MenuPanel` should not have to
    // decode "inspector" to learn what colour the shell is.
    const { container } = render(
      <MenuPanel width={268}>
        <span>no-inspector</span>
      </MenuPanel>,
    );
    expect(classOf(island(container))).not.toContain("bg-inspector");
  });

  it("applies the caller's width as an inline style (the shell owns no width of its own)", () => {
    // The number belongs to the CALLER — Settings' nav passes 268 today. The
    // shell persists nothing: no `localStorage`, no clamp, no drag handle. That
    // machinery is the Side pane's, along with its `side-pane-width` key and its
    // 240–480px clamp.
    const { container } = render(
      <MenuPanel width={268}>
        <span>fixed-width</span>
      </MenuPanel>,
    );
    const root = island(container);
    expect(root.style.width).toBe("268px");
    // …and the recipe carries no width utility of its own to fight it.
    expect(classOf(root).split(/\s+/)).not.toContain("w-64");
  });

  it("renders a PLAIN <div> and NO landmark of any kind", () => {
    // THE TRAP this pin exists for. The accessible name
    // `aria-label="Settings sections"` belongs to the `<nav>` INSIDE the shell.
    // A second `navigation` landmark carrying the same name would make
    // `getByRole("navigation", { name: … })` throw "found multiple elements" and
    // redden three sites in `App.test.tsx`. So the shell takes no `ariaLabel`
    // prop and emits no role.
    const { container } = render(
      <MenuPanel width={268}>
        <span>no-landmark</span>
      </MenuPanel>,
    );
    const root = island(container);
    expect(root.tagName).toBe("DIV");
    expect(root.getAttribute("aria-label")).toBeNull();
    expect(root.getAttribute("role")).toBeNull();
    expect(container.querySelector("nav")).toBeNull();
    expect(container.querySelector("aside")).toBeNull();
  });

  it("adds NO element of its own around the children", () => {
    // The shell IS the island. A wrapper between it and the caller's content
    // would sit between the shell's `overflow-hidden` and the caller's own
    // `flex-1` scroller and break the scroll chain `SidePane.tsx:210`/`:237`
    // rely on.
    const { container } = render(
      <MenuPanel width={268}>
        <span>a</span>
        <span>b</span>
      </MenuPanel>,
    );
    const root = island(container);
    expect(root.children).toHaveLength(2);
    expect(root.textContent).toBe("ab");
  });

  it("emits no stray whitespace in the class attribute", () => {
    const { container } = render(
      <MenuPanel width={268}>
        <span>x</span>
      </MenuPanel>,
    );
    const cls = classOf(island(container));
    expect(cls).not.toMatch(/\s$/);
    expect(cls).not.toMatch(/^\s/);
    expect(cls).not.toMatch(/\s\s/);
  });
});
