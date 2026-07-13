import { describe, expect, it, vi } from "vitest";

import { runPageCommand, type PopupBrowser } from "../src/popup/client";

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
          state: { translationCount: 2, failureCount: 0, visible: true },
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
});
