import { afterEach, describe, expect, it, vi } from "vitest";

import { bootstrapContentRuntime } from "../src/content/bootstrap";
import {
  createDisableSiteMessage,
  createGetSiteStateMessage,
} from "../src/messaging/settings-protocol";
import { siteKeyFromUrl } from "../src/settings/site-preferences";
import { captureShadowRoots, trustedClick } from "./helpers/dom";

afterEach(() => {
  document.documentElement
    .querySelectorAll('[data-paralume-owned="true"]')
    .forEach((element) => {
      element.remove();
    });
});

function runtime(siteState: unknown) {
  return {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn((message: unknown) => {
      const command =
        typeof message === "object" && message !== null && "command" in message
          ? message.command
          : undefined;
      return Promise.resolve(
        command === "get-site-state"
          ? siteState
          : command === "disable-site"
            ? { protocolVersion: 1, ok: true }
            : undefined,
      );
    }),
  };
}

const enabledSite = { protocolVersion: 1, ok: true, siteDisabled: false };

describe("automatic content bootstrap", () => {
  it("shows the floating menu by default on ordinary web pages", async () => {
    const api = runtime(enabledSite);

    await expect(
      bootstrapContentRuntime(
        document,
        location,
        {},
        { runtime: api, getUiLanguage: () => "en-US" },
      ),
    ).resolves.toBe(true);

    expect(
      document.querySelector('[data-paralume-owned="true"]'),
    ).not.toBeNull();
    // The site preference comes from the background; the message carries no
    // site, so the background derives it from the browser-provided sender.
    expect(api.sendMessage).toHaveBeenCalledWith(createGetSiteStateMessage());
  });

  it("does not install on a site that the user disabled", async () => {
    await expect(
      bootstrapContentRuntime(
        document,
        location,
        {},
        {
          runtime: runtime({
            protocolVersion: 1,
            ok: true,
            siteDisabled: true,
          }),
          getUiLanguage: () => "zh-CN",
        },
      ),
    ).resolves.toBe(false);

    expect(document.querySelector('[data-paralume-owned="true"]')).toBeNull();
  });

  it.each([
    undefined,
    { protocolVersion: 1, ok: true },
    { protocolVersion: 1, ok: true, siteDisabled: "no" },
    {
      protocolVersion: 1,
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Paralume could not complete the request.",
        retryable: true,
      },
    },
  ])("stays off when the site state is unavailable: %j", async (state) => {
    await expect(
      bootstrapContentRuntime(
        document,
        location,
        {},
        { runtime: runtime(state), getUiLanguage: () => "en-US" },
      ),
    ).resolves.toBe(false);

    expect(document.querySelector('[data-paralume-owned="true"]')).toBeNull();
  });

  it("does not read extension storage from the content script", async () => {
    const storage = {
      local: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
      },
    };

    await bootstrapContentRuntime(
      document,
      location,
      {},
      // Extra properties are ignored; storage must never be consulted.
      Object.assign(
        { runtime: runtime(enabledSite), getUiLanguage: () => "en-US" },
        { storage },
      ),
    );

    expect(storage.local.get).not.toHaveBeenCalled();
    expect(storage.local.set).not.toHaveBeenCalled();
  });

  it("derives the same site keys the background uses", () => {
    expect(siteKeyFromUrl("https://news.example.com:8443/a?b#c")).toBe(
      "news.example.com",
    );
    expect(siteKeyFromUrl("file:///home/user/page.html")).toBe("file://");
    expect(
      siteKeyFromUrl("chrome-extension://abc/options.html"),
    ).toBeUndefined();
    expect(siteKeyFromUrl("about:blank")).toBeUndefined();
    expect(siteKeyFromUrl("not a url")).toBeUndefined();
    expect(siteKeyFromUrl(undefined)).toBeUndefined();
  });

  it("asks the background to disable the current site from the menu", async () => {
    const roots = captureShadowRoots();
    const api = runtime(enabledSite);
    await bootstrapContentRuntime(
      document,
      location,
      {},
      { runtime: api, getUiLanguage: () => "en-US" },
    );
    const disableButton = roots[0]?.querySelector(
      '[data-action="disable-site"]',
    );
    if (disableButton === null || disableButton === undefined) {
      throw new Error("The disable-site control was not rendered.");
    }

    trustedClick(disableButton);

    await vi.waitFor(() => {
      expect(document.querySelector('[data-paralume-owned="true"]')).toBeNull();
    });
    expect(api.sendMessage).toHaveBeenCalledWith(createDisableSiteMessage());
  });

  it("keeps the menu when the background rejects the disable request", async () => {
    const roots = captureShadowRoots();
    const api = runtime(enabledSite);
    api.sendMessage.mockImplementation((message: unknown) =>
      Promise.resolve(
        typeof message === "object" &&
          message !== null &&
          "command" in message &&
          message.command === "get-site-state"
          ? enabledSite
          : {
              protocolVersion: 1,
              ok: false,
              error: {
                code: "INVALID_MESSAGE",
                message: "The request or response was malformed.",
                retryable: false,
              },
            },
      ),
    );
    await bootstrapContentRuntime(
      document,
      location,
      {},
      { runtime: api, getUiLanguage: () => "en-US" },
    );
    const disableButton = roots[0]?.querySelector(
      '[data-action="disable-site"]',
    );
    if (disableButton === null || disableButton === undefined) {
      throw new Error("The disable-site control was not rendered.");
    }

    trustedClick(disableButton);

    await vi.waitFor(() => {
      expect(api.sendMessage).toHaveBeenCalledWith(createDisableSiteMessage());
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(
      document.querySelector('[data-paralume-owned="true"]'),
    ).not.toBeNull();
  });
});
