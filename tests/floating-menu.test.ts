import { afterEach, describe, expect, it, vi } from "vitest";

import { installFloatingMenu } from "../src/content/floating-menu";

afterEach(() => {
  document.body.replaceChildren();
});

describe("page floating menu", () => {
  it("uses isolated Shadow DOM and expands the edge dock before translating", () => {
    const runCommand = vi.fn<
      (
        command: "status" | "translate" | "retry-failed" | "toggle" | "clear",
      ) => Promise<void>
    >(() => Promise.resolve());
    const menu = installFloatingMenu(document, runCommand, "en");

    expect(menu.host.shadowRoot).not.toBeNull();
    expect(menu.host.getAttribute("data-paralume-owned")).toBe("true");
    const shadow = menu.host.shadowRoot;
    shadow?.querySelector<HTMLButtonElement>('[data-action="expand"]')?.click();
    expect(shadow?.querySelector("[data-panel]")?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(runCommand).not.toHaveBeenCalled();
    shadow
      ?.querySelector<HTMLButtonElement>('[data-action="primary"]')
      ?.click();
    expect(runCommand).toHaveBeenCalledWith("translate");
  });

  it("shows working progress and exposes expanded visibility and clear actions", () => {
    const runCommand = vi.fn<
      (
        command: "status" | "translate" | "retry-failed" | "toggle" | "clear",
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

  it("hides for the page or persists a site disable choice", async () => {
    const disableSite = vi.fn(() => Promise.resolve());
    const first = installFloatingMenu(
      document,
      () => Promise.resolve(undefined),
      "zh-CN",
      { siteLabel: "example.com", disableSite },
    );
    first.host.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-action="hide-page"]')
      ?.click();
    expect(first.host.isConnected).toBe(false);

    const second = installFloatingMenu(
      document,
      () => Promise.resolve(undefined),
      "zh-CN",
      { siteLabel: "example.com", disableSite },
    );
    second.host.shadowRoot
      ?.querySelector<HTMLButtonElement>('[data-action="disable-site"]')
      ?.click();
    await vi.waitFor(() => {
      expect(disableSite).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(second.host.isConnected).toBe(false);
    });
  });
});
