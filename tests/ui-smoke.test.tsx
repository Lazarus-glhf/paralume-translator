import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { App as OptionsApp } from "../entrypoints/options/App";
import { App as PopupApp } from "../entrypoints/popup/App";
import type { ContentResponse } from "../src/messaging/protocol";
import type { OptionsClient } from "../src/options/client";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
} from "../src/settings/repository";
import type {
  ContentSettings,
  PublicProviderSettings,
} from "../src/settings/types";

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

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function contentSettings(
  overrides: Partial<ContentSettings> = {},
): ContentSettings {
  return {
    retry: { ...DEFAULT_RETRY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
    uiLanguage: "system",
    ...overrides,
  };
}

function publicSettings(
  overrides: Partial<PublicProviderSettings> = {},
): PublicProviderSettings {
  return {
    version: 2,
    provider: "openai",
    openai: {
      ...DEFAULT_PROVIDER_SETTINGS.openai,
      apiKeyConfigured: true,
    },
    microsoft: {
      ...DEFAULT_PROVIDER_SETTINGS.microsoft,
      apiKeyConfigured: false,
    },
    retry: { ...DEFAULT_RETRY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
    uiLanguage: "system",
    ...overrides,
  };
}

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.replaceChildren();
});

describe("localized Popup", () => {
  it("starts translation when the toolbar popup opens", async () => {
    const runCommand = vi.fn(() =>
      Promise.resolve<ContentResponse>({
        protocolVersion: 1,
        ok: true,
        state: { translationCount: 1, failureCount: 0, visible: true },
        message: {
          id: "content.translationSummary",
          values: { succeeded: 1, failed: 0 },
        },
      }),
    );
    render(
      <PopupApp
        runCommand={runCommand}
        loadContentSettings={() => Promise.resolve(contentSettings())}
      />,
    );

    await flushEffects();
    await flushEffects();
    expect(runCommand).toHaveBeenCalledOnce();
    expect(runCommand).toHaveBeenCalledWith("translate");
  });

  it("runs accessible English actions and formats stable status identifiers", async () => {
    const runCommand = vi.fn(
      (
        command: "translate" | "retry-failed" | "toggle" | "clear",
      ): Promise<ContentResponse> =>
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
              ? {
                  id: "content.translationSummary",
                  values: { succeeded: 2, failed: 0 },
                }
              : command === "toggle"
                ? { id: "content.hidden" }
                : { id: "content.cleared", values: { count: 2 } },
        }),
    );
    const popup = render(
      <PopupApp
        autoStart={false}
        runCommand={runCommand}
        loadContentSettings={() => Promise.resolve(contentSettings())}
        getBrowserUiLanguage={() => "en-US"}
      />,
    );
    await flushEffects();

    const translate = popup.querySelector<HTMLButtonElement>(
      'button[data-action="translate"]',
    );
    const toggle = popup.querySelector<HTMLButtonElement>(
      'button[data-action="toggle"]',
    );
    expect(popup.querySelector("h1")?.textContent).toBe("Paralume");
    expect(popup.querySelectorAll("button")).toHaveLength(3);
    expect(translate?.textContent).toBe("Translate page");

    await act(async () => {
      translate?.click();
      await Promise.resolve();
    });
    expect(runCommand).toHaveBeenCalledWith("translate");
    expect(popup.querySelector('[role="status"]')?.textContent).toContain(
      "Translated 2 readable blocks",
    );
    expect(popup.textContent).toContain("Translations: 2");

    await act(async () => {
      toggle?.click();
      await Promise.resolve();
    });
    expect(runCommand).toHaveBeenCalledWith("toggle");
    expect(popup.textContent).toContain("Translations are hidden.");
  });

  it("renders Simplified Chinese controls and fixed errors from the configured locale", async () => {
    const popup = render(
      <PopupApp
        autoStart={false}
        loadContentSettings={() =>
          Promise.resolve(contentSettings({ uiLanguage: "zh-CN" }))
        }
        getBrowserUiLanguage={() => "en-US"}
        runCommand={() =>
          Promise.resolve({
            protocolVersion: 1,
            ok: false,
            error: {
              code: "RESTRICTED_PAGE",
              message: "English protocol fallback must not drive the UI.",
              retryable: false,
            },
          })
        }
      />,
    );
    await flushEffects();

    expect(popup.textContent).toContain("翻译页面");
    expect(popup.textContent).toContain("显示 / 隐藏");
    await act(async () => {
      popup
        .querySelector<HTMLButtonElement>('button[data-action="translate"]')
        ?.click();
      await Promise.resolve();
    });
    expect(popup.querySelector('[role="alert"]')?.textContent).toContain(
      "浏览器内部页面",
    );
    expect(popup.textContent).not.toContain("English protocol fallback");
  });

  it("disables actions while pending and recovers from an unexpected rejection", async () => {
    let rejectCommand: ((error: Error) => void) | undefined;
    const popup = render(
      <PopupApp
        autoStart={false}
        loadContentSettings={() => Promise.resolve(contentSettings())}
        getBrowserUiLanguage={() => "en-US"}
        runCommand={() =>
          new Promise<ContentResponse>((_resolve, reject) => {
            rejectCommand = reject;
          })
        }
      />,
    );
    await flushEffects();

    act(() => {
      popup
        .querySelector<HTMLButtonElement>('button[data-action="translate"]')
        ?.click();
    });
    expect(popup.querySelector("main")?.getAttribute("aria-busy")).toBe("true");
    expect(
      Array.from(popup.querySelectorAll<HTMLButtonElement>("button")).every(
        (button) => button.disabled,
      ),
    ).toBe(true);
    expect(popup.textContent).toContain("Translating…");

    await act(async () => {
      rejectCommand?.(new Error("LEAK_SECRET_popup"));
      await Promise.resolve();
    });
    expect(popup.querySelector('[role="alert"]')?.textContent).toBe(
      "Paralume could not complete the request.",
    );
    expect(popup.textContent).not.toContain("LEAK_SECRET_popup");
    expect(popup.querySelector("main")?.getAttribute("aria-busy")).toBe(
      "false",
    );
  });
});

describe("localized Options", () => {
  it("loads configured credentials as masked empty inputs and renders all Milestone 3 controls", async () => {
    const loaded = publicSettings();
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(loaded)),
      save: vi.fn(),
      clearApiKey: vi.fn(),
      testConnection: vi.fn(),
    };
    const options = render(
      <OptionsApp client={client} getBrowserUiLanguage={() => "en-US"} />,
    );
    await flushEffects();

    const keyInput = options.querySelector<HTMLInputElement>(
      'input[name="openaiApiKey"]',
    );
    expect(options.querySelector("h1")?.textContent).toBe("Options");
    expect(keyInput?.type).toBe("password");
    expect(keyInput?.value).toBe("");
    expect(keyInput?.placeholder).toContain("configured");
    expect(options.querySelector('select[name="uiLanguage"]')).not.toBeNull();
    expect(options.querySelector('input[name="retryEnabled"]')).not.toBeNull();
    expect(
      options.querySelector('select[name="retryMaxRetries"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('select[name="appearanceFontFamily"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('input[name="appearanceFontSize"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('input[name="appearanceTextColor"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('input[name="appearanceBackgroundColor"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('input[name="appearanceLineHeight"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('input[name="appearanceOpacity"]'),
    ).not.toBeNull();
    expect(
      options.querySelector('input[name="appearanceVerticalSpacing"]'),
    ).not.toBeNull();
    expect(options.textContent).not.toContain("background-only-test-key");
  });

  it("switches immediately to Simplified Chinese and resets appearance safely", async () => {
    const loaded = publicSettings({
      uiLanguage: "zh-CN",
      appearance: {
        ...DEFAULT_APPEARANCE_SETTINGS,
        fontSize: 24,
        opacity: 0.6,
      },
    });
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(loaded)),
      save: vi.fn(),
      clearApiKey: vi.fn(),
      testConnection: vi.fn(),
    };
    const options = render(
      <OptionsApp client={client} getBrowserUiLanguage={() => "en-US"} />,
    );
    await flushEffects();

    expect(options.querySelector("h1")?.textContent).toBe("选项");
    expect(options.textContent).toContain("自动重试");
    expect(options.textContent).toContain("外观");
    expect(options.textContent).toContain("保存设置");
    act(() => {
      options
        .querySelector<HTMLButtonElement>(
          'button[data-action="reset-appearance"]',
        )
        ?.click();
    });
    expect(
      options.querySelector<HTMLInputElement>(
        'input[name="appearanceFontSize"]',
      )?.value,
    ).toBe(String(DEFAULT_APPEARANCE_SETTINGS.fontSize));
    expect(
      options.querySelector<HTMLInputElement>('input[name="appearanceOpacity"]')
        ?.value,
    ).toBe(String(DEFAULT_APPEARANCE_SETTINGS.opacity));
  });

  it("submits retry, appearance, language, and replacement keys with localized status", async () => {
    const loaded = publicSettings();
    const saved = {
      ...loaded,
      openai: { ...loaded.openai, apiKeyConfigured: true },
      uiLanguage: "zh-CN" as const,
    };
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(loaded)),
      save: vi.fn(() =>
        Promise.resolve({
          settings: saved,
          message: { id: "settings.saved" as const },
        }),
      ),
      clearApiKey: vi.fn(() =>
        Promise.resolve({
          settings: loaded,
          message: { id: "settings.openAiKeyCleared" as const },
        }),
      ),
      testConnection: vi.fn(),
    };
    const options = render(
      <OptionsApp client={client} getBrowserUiLanguage={() => "en-US"} />,
    );
    await flushEffects();

    const setInput = (selector: string, value: string) => {
      const input = options.querySelector<HTMLInputElement>(selector);
      if (input !== null) {
        Reflect.set(HTMLInputElement.prototype, "value", value, input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    };
    const language = options.querySelector<HTMLSelectElement>(
      'select[name="uiLanguage"]',
    );
    await act(async () => {
      setInput('input[name="openaiApiKey"]', "replacement-test-key");
      setInput('input[name="appearanceFontSize"]', "22");
      if (language !== null) {
        Reflect.set(HTMLSelectElement.prototype, "value", "zh-CN", language);
        language.dispatchEvent(new Event("change", { bubbles: true }));
      }
      options
        .querySelector<HTMLButtonElement>('button[data-action="save"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const submitted = vi.mocked(client.save).mock.calls[0];
    expect(submitted?.[0].uiLanguage).toBe("zh-CN");
    expect(submitted?.[0].retry).toEqual({ enabled: false, maxRetries: 0 });
    expect(submitted?.[0].appearance.fontSize).toBe(22);
    expect(submitted?.[1]).toEqual({
      openaiApiKey: "replacement-test-key",
    });
    expect(options.querySelector('[role="status"]')?.textContent).toBe(
      "设置已保存。",
    );
  });

  it("localizes safe validation errors without rendering arbitrary exception details", async () => {
    const loaded = publicSettings({ provider: "mock", uiLanguage: "zh-CN" });
    const client: OptionsClient = {
      load: vi.fn(() => Promise.resolve(loaded)),
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
    const options = render(
      <OptionsApp client={client} getBrowserUiLanguage={() => "en-US"} />,
    );
    await flushEffects();

    await act(async () => {
      options
        .querySelector<HTMLButtonElement>('button[data-action="save"]')
        ?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(options.querySelector('[role="alert"]')?.textContent).toBe(
      "Paralume 无法完成该请求。",
    );
    expect(options.textContent).not.toMatch(
      /LEAK_SECRET|private\.invalid|LEAK_PAGE_TEXT/u,
    );
  });
});
