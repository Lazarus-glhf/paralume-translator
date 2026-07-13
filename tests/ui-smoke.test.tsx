import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App as OptionsApp } from "../entrypoints/options/App";
import { App as PopupApp } from "../entrypoints/popup/App";
import type { ContentResponse } from "../src/messaging/protocol";

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

describe("extension UI", () => {
  it("runs accessible popup actions and reflects page visibility/status", async () => {
    const runCommand = vi.fn(
      (command: "translate" | "toggle" | "clear"): Promise<ContentResponse> =>
        Promise.resolve({
          protocolVersion: 1,
          ok: true,
          state: {
            translationCount: command === "clear" ? 0 : 2,
            failureCount: 0,
            visible: command !== "toggle",
          },
          message:
            command === "translate"
              ? "Translated 2 readable blocks."
              : command === "toggle"
                ? "Translations hidden."
                : "Cleared 2 translations.",
        }),
    );
    const popup = render(<PopupApp runCommand={runCommand} />);
    const translate = popup.querySelector<HTMLButtonElement>(
      'button[data-action="translate"]',
    );
    const toggle = popup.querySelector<HTMLButtonElement>(
      'button[data-action="toggle"]',
    );

    expect(popup.querySelector("h1")?.textContent).toBe("Paralume");
    expect(popup.querySelectorAll("button")).toHaveLength(3);
    expect(toggle?.textContent).toContain("Hide translations");

    await act(async () => {
      translate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(runCommand).toHaveBeenCalledWith("translate");
    expect(popup.querySelector('[role="status"]')?.textContent).toContain(
      "Translated 2 readable blocks",
    );

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    expect(runCommand).toHaveBeenCalledWith("toggle");
    expect(toggle?.textContent).toContain("Show translations");
  });

  it("disables all popup actions and exposes aria-busy while a command is pending", async () => {
    let resolveCommand: ((response: ContentResponse) => void) | undefined;
    const runCommand = vi.fn(
      () =>
        new Promise<ContentResponse>((resolve) => {
          resolveCommand = resolve;
        }),
    );
    const popup = render(<PopupApp runCommand={runCommand} />);
    const translate = popup.querySelector<HTMLButtonElement>(
      'button[data-action="translate"]',
    );

    act(() => {
      translate?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(popup.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(
      Array.from(popup.querySelectorAll<HTMLButtonElement>("button")).every(
        (button) => button.disabled,
      ),
    ).toBe(true);

    await act(async () => {
      resolveCommand?.({
        protocolVersion: 1,
        ok: true,
        state: { translationCount: 1, failureCount: 0, visible: true },
        message: "Translated 1 readable block.",
      });
      await Promise.resolve();
    });
    expect(popup.querySelector("main")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });

  it("announces popup errors without replacing the status region", async () => {
    const popup = render(
      <PopupApp
        runCommand={() =>
          Promise.resolve({
            protocolVersion: 1,
            ok: false,
            error: {
              code: "RESTRICTED_PAGE",
              message: "Paralume cannot run on browser-internal pages.",
              retryable: false,
            },
          })
        }
      />,
    );

    await act(async () => {
      popup
        .querySelector<HTMLButtonElement>('button[data-action="translate"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(popup.querySelector('[role="alert"]')?.textContent).toContain(
      "browser-internal",
    );
    expect(popup.querySelector('[role="status"]')).not.toBeNull();
  });

  it("announces an unexpected command rejection and leaves the UI usable", async () => {
    const popup = render(
      <PopupApp
        runCommand={() => Promise.reject(new Error("Unexpected failure"))}
      />,
    );

    await act(async () => {
      popup
        .querySelector<HTMLButtonElement>('button[data-action="translate"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(popup.querySelector('[role="alert"]')?.textContent).toContain(
      "could not complete",
    );
    expect(popup.querySelector("main")?.getAttribute("aria-busy")).toBe(
      "false",
    );
    expect(
      Array.from(popup.querySelectorAll<HTMLButtonElement>("button")).every(
        (button) => !button.disabled,
      ),
    ).toBe(true);
  });

  it("identifies Mock mode honestly without speculative settings", () => {
    const options = render(<OptionsApp />);

    expect(options.querySelector("h1")?.textContent).toBe("Options");
    expect(options.querySelector('[role="status"]')?.textContent).toContain(
      "Mock provider",
    );
    expect(options.querySelectorAll("input, select, textarea")).toHaveLength(0);
  });
});
