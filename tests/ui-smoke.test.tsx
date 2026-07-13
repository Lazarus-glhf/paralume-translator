import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App as OptionsApp } from "../entrypoints/options/App";
import { App as PopupApp } from "../entrypoints/popup/App";
import type { ContentResponse } from "../src/messaging/protocol";
import type { OptionsClient } from "../src/options/client";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/repository";
import type { PublicProviderSettings } from "../src/settings/types";

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

  it("loads configured credentials as masked, empty inputs", async () => {
    const loadedSettings: PublicProviderSettings = {
      version: 1,
      provider: "openai",
      openai: {
        baseUrl: DEFAULT_PROVIDER_SETTINGS.openai.baseUrl,
        model: DEFAULT_PROVIDER_SETTINGS.openai.model,
        protocol: DEFAULT_PROVIDER_SETTINGS.openai.protocol,
        reasoningEffort: DEFAULT_PROVIDER_SETTINGS.openai.reasoningEffort,
        apiKeyConfigured: true,
      },
      microsoft: {
        endpoint: DEFAULT_PROVIDER_SETTINGS.microsoft.endpoint,
        region: DEFAULT_PROVIDER_SETTINGS.microsoft.region,
        apiKeyConfigured: false,
      },
    };
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(loadedSettings)),
      save: vi.fn(),
      clearApiKey: vi.fn(),
      testConnection: vi.fn(),
    };
    const options = render(<OptionsApp client={client} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const keyInput = options.querySelector<HTMLInputElement>(
      'input[name="openaiApiKey"]',
    );
    expect(options.querySelector("h1")?.textContent).toBe("Options");
    expect(keyInput?.type).toBe("password");
    expect(keyInput?.value).toBe("");
    expect(keyInput?.placeholder).toContain("configured");
    expect(options.textContent).not.toContain("background-only-test-key");
  });

  it("submits replacement keys, reports save status, and clears them explicitly", async () => {
    const publicSettings = {
      version: 1 as const,
      provider: "openai" as const,
      openai: {
        ...DEFAULT_PROVIDER_SETTINGS.openai,
        apiKeyConfigured: false,
      },
      microsoft: {
        ...DEFAULT_PROVIDER_SETTINGS.microsoft,
        apiKeyConfigured: false,
      },
    };
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(publicSettings)),
      save: vi.fn(() =>
        Promise.resolve({
          settings: {
            ...publicSettings,
            openai: { ...publicSettings.openai, apiKeyConfigured: true },
          },
          message: "Settings saved.",
        }),
      ),
      clearApiKey: vi.fn(() =>
        Promise.resolve({
          settings: publicSettings,
          message: "OpenAI-compatible API key cleared.",
        }),
      ),
      testConnection: vi.fn(),
    };
    const options = render(<OptionsApp client={client} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const keyInput = options.querySelector<HTMLInputElement>(
      'input[name="openaiApiKey"]',
    );
    await act(async () => {
      if (keyInput !== null) {
        Reflect.set(
          HTMLInputElement.prototype,
          "value",
          "replacement-test-key",
          keyInput,
        );
        keyInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
      options
        .querySelector<HTMLButtonElement>('button[data-action="save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai" }),
      { openaiApiKey: "replacement-test-key" },
    );
    expect(options.querySelector('[role="status"]')?.textContent).toContain(
      "Settings saved",
    );
    expect(keyInput?.value).toBe("");

    await act(async () => {
      options
        .querySelector<HTMLButtonElement>(
          'button[data-action="clear-openai-key"]',
        )
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.clearApiKey).toHaveBeenCalledWith("openai");
  });

  it("does not render arbitrary Options client exception details", async () => {
    const publicSettings = {
      version: 1 as const,
      provider: "mock" as const,
      openai: {
        ...DEFAULT_PROVIDER_SETTINGS.openai,
        apiKeyConfigured: false,
      },
      microsoft: {
        ...DEFAULT_PROVIDER_SETTINGS.microsoft,
        apiKeyConfigured: false,
      },
    };
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(publicSettings)),
      save: vi.fn(() =>
        Promise.reject(
          new Error(
            "LEAK_SECRET_6be1 https://private.invalid LEAK_PAGE_TEXT_88",
          ),
        ),
      ),
      clearApiKey: vi.fn(),
      testConnection: vi.fn(),
    };
    const options = render(<OptionsApp client={client} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      options
        .querySelector<HTMLButtonElement>('button[data-action="save"]')
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(options.querySelector('[role="alert"]')?.textContent).toBe(
      "Paralume could not complete the request.",
    );
    expect(options.textContent).not.toMatch(
      /LEAK_SECRET|private\.invalid|LEAK_PAGE_TEXT/u,
    );
  });
});
