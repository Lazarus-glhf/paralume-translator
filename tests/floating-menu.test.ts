import { afterEach, describe, expect, it, vi } from "vitest";

import { installFloatingMenu } from "../src/content/floating-menu";
import { captureShadowRoots, trustedClick } from "./helpers/dom";

afterEach(() => {
  document.body.replaceChildren();
  for (const host of document.querySelectorAll("[data-paralume-owned]")) {
    host.remove();
  }
});

type MenuCommand = "status" | "translate" | "retry-failed" | "toggle" | "clear";

function installWithShadow(...args: Parameters<typeof installFloatingMenu>): {
  menu: ReturnType<typeof installFloatingMenu>;
  shadow: ShadowRoot;
} {
  const roots = captureShadowRoots();
  const menu = installFloatingMenu(...args);
  const shadow = roots.at(-1);
  if (shadow === undefined) {
    throw new Error("The floating menu did not attach a shadow root.");
  }
  return { menu, shadow };
}

function control(shadow: ShadowRoot, action: string): HTMLButtonElement {
  const button = shadow.querySelector<HTMLButtonElement>(
    `[data-action="${action}"]`,
  );
  if (button === null) {
    throw new Error(`Floating menu control ${action} was not rendered.`);
  }
  return button;
}

describe("page floating menu", () => {
  it("uses a closed Shadow DOM and expands the edge dock before translating", () => {
    const runCommand = vi.fn<(command: MenuCommand) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const { menu, shadow } = installWithShadow(document, runCommand, "en");

    // Page scripts must not be able to reach the controls through the host.
    expect(menu.host.shadowRoot).toBeNull();
    expect(shadow.mode).toBe("closed");
    expect(menu.host.getAttribute("data-paralume-owned")).toBe("true");
    trustedClick(control(shadow, "expand"));
    expect(shadow.querySelector("[data-panel]")?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(runCommand).not.toHaveBeenCalled();
    trustedClick(control(shadow, "primary"));
    expect(runCommand).toHaveBeenCalledWith("translate");
  });

  it("ignores synthetic page clicks on every control", async () => {
    const runCommand = vi.fn<(command: MenuCommand) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const openSettings = vi.fn(() => Promise.resolve());
    const disableSite = vi.fn(() => Promise.resolve());
    const { menu, shadow } = installWithShadow(document, runCommand, "en", {
      openSettings,
      disableSite,
    });
    menu.setFailureCount(2);

    // Simulates a page script that obtained a reference to the controls:
    // both element.click() and dispatchEvent() produce untrusted events.
    for (const action of [
      "expand",
      "primary",
      "retry-failed",
      "toggle",
      "clear",
      "open-settings",
      "hide-page",
      "disable-site",
    ]) {
      const button = control(shadow, action);
      button.click();
      button.dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
    }
    await Promise.resolve();

    expect(runCommand).not.toHaveBeenCalled();
    expect(openSettings).not.toHaveBeenCalled();
    expect(disableSite).not.toHaveBeenCalled();
    expect(menu.host.isConnected).toBe(true);
    expect(shadow.querySelector("[data-panel]")?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(control(shadow, "expand").getAttribute("aria-expanded")).toBe(
      "false",
    );

    // The same controls still respond to real user input.
    trustedClick(control(shadow, "primary"));
    expect(runCommand).toHaveBeenCalledExactlyOnceWith("translate");
  });

  it("shows working progress and exposes expanded visibility and clear actions", () => {
    const runCommand = vi.fn<(command: MenuCommand) => Promise<void>>(() =>
      Promise.resolve(),
    );
    const { menu, shadow } = installWithShadow(document, runCommand, "zh-CN");
    menu.setProgress({ phase: "translating", completed: 4, total: 15 });

    expect(shadow.querySelector('[role="status"]')?.textContent).toContain(
      "4 / 15",
    );
    trustedClick(control(shadow, "expand"));
    expect(shadow.querySelector("[data-panel]")?.hasAttribute("hidden")).toBe(
      false,
    );
    menu.setFailureCount(2);
    trustedClick(control(shadow, "retry-failed"));
    trustedClick(control(shadow, "toggle"));
    trustedClick(control(shadow, "clear"));
    expect(runCommand.mock.calls.map(([command]) => command)).toEqual([
      "retry-failed",
      "toggle",
      "clear",
    ]);
  });

  it("shows the localized error reason and an Open settings action for configuration failures", async () => {
    const runCommand = vi.fn(() =>
      Promise.resolve({
        protocolVersion: 1,
        ok: false,
        error: {
          code: "API_KEY_UNCONFIGURED",
          message: "UNTRUSTED_RESPONSE_TEXT",
          retryable: false,
        },
      }),
    );
    const openSettings = vi.fn(() => Promise.resolve());
    const { menu, shadow } = installWithShadow(document, runCommand, "en", {
      openSettings,
    });
    const notice = shadow.querySelector<HTMLElement>("[data-error]");
    const noticeText = () =>
      shadow.querySelector("[data-error-text]")?.textContent;
    const settingsButton = control(shadow, "open-settings");
    expect(notice?.hidden).toBe(true);

    trustedClick(control(shadow, "primary"));
    menu.setProgress({ phase: "error", completed: 0, total: 2 });
    await vi.waitFor(() => {
      expect(notice?.hidden).toBe(false);
    });
    expect(noticeText()).toBe(
      "The selected provider API key is not configured.",
    );
    expect(shadow.textContent).not.toContain("UNTRUSTED_RESPONSE_TEXT");
    expect(settingsButton.hidden).toBe(false);
    expect(settingsButton.textContent).toBe("Open settings");

    menu.setLocale("zh-CN");
    expect(noticeText()).toBe("尚未配置所选翻译服务的 API 密钥。");
    expect(settingsButton.textContent).toBe("打开设置");

    settingsButton.click();
    expect(openSettings).not.toHaveBeenCalled();
    trustedClick(settingsButton);
    expect(openSettings).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledOnce();

    menu.setProgress({ phase: "translating", completed: 0, total: 2 });
    expect(notice?.hidden).toBe(true);
    menu.host.remove();
  });

  it("shows non-configuration errors without a settings action and ignores superseded or malformed responses", async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    const runCommand = vi
      .fn<(command: MenuCommand) => Promise<unknown>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: false,
        error: {
          code: "REQUEST_TIMEOUT",
          message: "ignored",
          retryable: true,
        },
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: false,
        error: { code: "<img src=x>", message: "ignored", retryable: false },
      });
    const { menu, shadow } = installWithShadow(document, runCommand, "en", {
      openSettings: () => Promise.resolve(),
    });
    const notice = shadow.querySelector<HTMLElement>("[data-error]");
    const noticeText = () =>
      shadow.querySelector("[data-error-text]")?.textContent;
    const settingsButton = control(shadow, "open-settings");

    trustedClick(control(shadow, "primary"));
    trustedClick(control(shadow, "toggle"));
    await vi.waitFor(() => {
      expect(noticeText()).toBe("The provider request timed out. Try again.");
    });
    expect(notice?.hidden).toBe(false);
    expect(settingsButton.hidden).toBe(true);

    // The superseded first command must not overwrite the latest outcome.
    resolveFirst({
      protocolVersion: 1,
      ok: false,
      error: {
        code: "API_KEY_UNCONFIGURED",
        message: "ignored",
        retryable: false,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(noticeText()).toBe("The provider request timed out. Try again.");
    expect(settingsButton.hidden).toBe(true);

    trustedClick(control(shadow, "clear"));
    await vi.waitFor(() => {
      expect(runCommand).toHaveBeenCalledTimes(3);
    });
    await Promise.resolve();
    expect(notice?.hidden).toBe(true);
    expect(shadow.innerHTML).not.toContain("<img");
    menu.host.remove();
  });

  it("hides for the page or persists a site disable choice", async () => {
    const disableSite = vi.fn(() => Promise.resolve());
    const first = installWithShadow(
      document,
      () => Promise.resolve(undefined),
      "zh-CN",
      { siteLabel: "example.com", disableSite },
    );
    trustedClick(control(first.shadow, "hide-page"));
    expect(first.menu.host.isConnected).toBe(false);

    const second = installWithShadow(
      document,
      () => Promise.resolve(undefined),
      "zh-CN",
      { siteLabel: "example.com", disableSite },
    );
    trustedClick(control(second.shadow, "disable-site"));
    await vi.waitFor(() => {
      expect(disableSite).toHaveBeenCalledOnce();
    });
    await vi.waitFor(() => {
      expect(second.menu.host.isConnected).toBe(false);
    });
  });
});
