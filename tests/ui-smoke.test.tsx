import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

import { App as OptionsApp } from "../entrypoints/options/App";
import { App as PopupApp } from "../entrypoints/popup/App";

const mountedRoots: Root[] = [];

function render(ui: ReactNode) {
  const container = document.createElement("div");
  document.body.append(container);

  const root = createRoot(container);
  mountedRoots.push(root);
  act(() => {
    root.render(ui);
  });

  return container;
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }

  document.body.replaceChildren();
});

describe("extension UI scaffold", () => {
  it("renders an honest, non-interactive popup boundary", () => {
    const popup = render(<PopupApp />);

    expect(popup.querySelector("h1")?.textContent).toBe("Paralume");
    expect(popup.querySelector('[role="status"]')?.textContent).toContain(
      "No page content is processed",
    );
    expect(popup.querySelectorAll("button")).toHaveLength(0);
  });

  it("renders the options boundary without speculative settings", () => {
    const options = render(<OptionsApp />);

    expect(options.querySelector("h1")?.textContent).toBe("Options");
    expect(options.querySelector('[role="status"]')?.textContent).toContain(
      "no configurable settings",
    );
    expect(options.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });
});
