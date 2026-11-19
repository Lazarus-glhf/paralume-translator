import { describe, expect, it, vi } from "vitest";

import {
  enablePopupSite,
  loadPopupSiteState,
  runPageCommand,
  type PopupBrowser,
} from "../src/popup/client";

function createBrowser(overrides: Partial<PopupBrowser> = {}): PopupBrowser {
  return {
    tabs: {
      query: vi.fn(() =>
        Promise.resolve([{ id: 42, url: "https://example.com/article" }]),
      ),
      sendMessage: vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          ok: true,
          state: {
            translationCount: 2,
            failureCount: 0,
            visible: true,
            working: false,
          },
          message: {
            id: "content.translationSummary",
            values: { succeeded: 2, failed: 0 },
          },
        }),
      ),
    },
    scripting: {
      executeScript: vi.fn(() => Promise.resolve([])),
    },
    ...overrides,
  };
}

function successState(working: boolean) {
  return {
    protocolVersion: 1 as const,
    ok: true as const,
    state: {
      translationCount: 0,
      failureCount: 0,
      visible: true,
      working,
    },
    message: {
      id: working
        ? ("popup.translating" as const)
        : ("content.stopEmpty" as const),
    },
  };
}

describe("popup page-command client", () => {
  it("injects the unlisted content artifact only after a page command", async () => {
    const api = createBrowser();

    const response = await runPageCommand("translate", api);

    expect(api.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 42 },
      files: ["paralume.js"],
    });
    expect(api.tabs.sendMessage).toHaveBeenCalledWith(42, {
      protocolVersion: 1,
      target: "content",
      command: "translate",
    });
    expect(response).toMatchObject({
      ok: true,
      state: { translationCount: 2 },
    });
  });

  it("reports browser-internal pages clearly without attempting injection", async () => {
    const executeScript = vi.fn(() => Promise.resolve([]));
    const api = createBrowser({
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([{ id: 7, url: "chrome://extensions" }]),
        ),
        sendMessage: vi.fn(() => Promise.resolve(undefined)),
      },
      scripting: { executeScript },
    });

    const response = await runPageCommand("translate", api);

    expect(response).toMatchObject({
      ok: false,
      error: { code: "RESTRICTED_PAGE" },
    });
    if (response.ok) {
      throw new Error("Expected a restricted-page error.");
    }
    expect(response.error.message).toContain("browser-internal");
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("reports missing tabs, failed injection, and malformed page responses", async () => {
    const noTab = createBrowser({
      tabs: {
        query: vi.fn(() => Promise.resolve([])),
        sendMessage: vi.fn(() => Promise.resolve(undefined)),
      },
    });
    await expect(runPageCommand("clear", noTab)).resolves.toMatchObject({
      ok: false,
      error: { code: "NO_ACTIVE_TAB" },
    });

    const failedInjection = createBrowser({
      scripting: {
        executeScript: vi.fn(() =>
          Promise.reject(new Error("Cannot access page")),
        ),
      },
    });
    await expect(
      runPageCommand("translate", failedInjection),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INJECTION_FAILED" },
    });

    const malformedResponse = createBrowser({
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([{ id: 42, url: "https://example.com/article" }]),
        ),
        sendMessage: vi.fn(() => Promise.resolve({ ok: true })),
      },
    });
    await expect(
      runPageCommand("toggle", malformedResponse),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
  });

  it("turns an active-tab query failure into a structured UI-safe error", async () => {
    const api = createBrowser({
      tabs: {
        query: vi.fn(() => Promise.reject(new Error("Browser query failed"))),
        sendMessage: vi.fn(() => Promise.resolve(undefined)),
      },
    });

    await expect(runPageCommand("translate", api)).resolves.toMatchObject({
      ok: false,
      error: { code: "NO_ACTIVE_TAB", retryable: true },
    });
  });

  it("derives the current hostname from the active tab and restores it through settings", async () => {
    const api = createBrowser({
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([
            { id: 42, url: "https://News.Example.com/article?id=1" },
          ]),
        ),
        sendMessage: vi.fn(),
      },
    });
    const runtime = {
      sendMessage: vi
        .fn()
        .mockResolvedValueOnce({
          protocolVersion: 1,
          ok: true,
          sites: ["news.example.com"],
        })
        .mockResolvedValueOnce({ protocolVersion: 1, ok: true }),
    };

    await expect(loadPopupSiteState(api, runtime)).resolves.toEqual({
      site: "news.example.com",
      disabled: true,
    });
    await enablePopupSite("news.example.com", runtime);
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(1, {
      protocolVersion: 1,
      target: "settings",
      command: "list-disabled-sites",
    });
    expect(runtime.sendMessage).toHaveBeenNthCalledWith(2, {
      protocolVersion: 1,
      target: "settings",
      command: "enable-site",
      site: "news.example.com",
    });
  });

  it("rejects malformed restore targets before messaging", async () => {
    const runtime = { sendMessage: vi.fn() };
    await expect(
      enablePopupSite("https://attacker.example/path", runtime),
    ).rejects.toMatchObject({ code: "INVALID_MESSAGE" });
    expect(runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("dispatches Stop after Translate is posted without awaiting Translate completion", async () => {
    let resolveTranslate: ((value: unknown) => void) | undefined;
    const commands: string[] = [];
    const api = createBrowser({
      tabs: {
        query: vi.fn(() =>
          Promise.resolve([{ id: 42, url: "https://example.com/article" }]),
        ),
        sendMessage: vi.fn((_tabId, message) => {
          const command = (message as { command?: string }).command ?? "";
          commands.push(command);
          if (command === "translate") {
            return new Promise((resolve) => {
              resolveTranslate = resolve;
            });
          }
          return Promise.resolve(successState(false));
        }),
      },
    });

    const translating = runPageCommand("translate", api);
    await vi.waitFor(() => {
      expect(commands).toEqual(["translate"]);
    });
    const stopping = runPageCommand("stop", api);
    await expect(stopping).resolves.toMatchObject({
      ok: true,
      state: { working: false },
    });
    expect(commands).toEqual(["translate", "stop"]);

    resolveTranslate?.(successState(false));
    await translating;
  });
});
