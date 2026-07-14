import { afterEach, describe, expect, it, vi } from "vitest";

import { installFloatingMenu } from "../src/content/floating-menu";

afterEach(() => {
  document.body.replaceChildren();
});

describe("page floating menu", () => {
  it("uses isolated Shadow DOM and makes the dock button translate by default", () => {
    const runCommand = vi.fn<
      (
        command: "translate" | "retry-failed" | "toggle" | "clear",
      ) => Promise<void>
    >(() => Promise.resolve());
    const menu = installFloatingMenu(document, runCommand, "en");

    expect(menu.host.shadowRoot).not.toBeNull();
    expect(menu.host.getAttribute("data-paralume-owned")).toBe("true");
    menu.host.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-action="primary"]')
      ?.click();
    expect(runCommand).toHaveBeenCalledWith("translate");
  });

  it("shows working progress and exposes expanded visibility and clear actions", () => {
    const runCommand = vi.fn<
      (
        command: "translate" | "retry-failed" | "toggle" | "clear",
      ) => Promise<void>
    >(() => Promise.resolve());
    const menu = installFloatingMenu(document, runCommand, "zh-CN");
    menu.setProgress({ phase: "translating", completed: 4, total: 15 });
    const shadow = menu.host.shadowRoot;

    expect(shadow?.querySelector('[role="status"]')?.textContent).toContain(
      "4 / 15",
    );
    shadow?.querySelector<HTMLButtonElement>('[data-action="expand"]')?.click();
    expect(shadow?.querySelector("[data-panel]")?.hasAttribute("hidden")).toBe(
      false,
    );
    menu.setFailureCount(2);
    shadow
      ?.querySelector<HTMLButtonElement>('[data-action="retry-failed"]')
      ?.click();
    shadow?.querySelector<HTMLButtonElement>('[data-action="toggle"]')?.click();
    shadow?.querySelector<HTMLButtonElement>('[data-action="clear"]')?.click();
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      "retry-failed",
      "toggle",
      "clear",
    ]);
  });
});
