import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bootstrapContentRuntime,
  DISABLED_SITES_STORAGE_KEY,
} from "../src/content/bootstrap";

afterEach(() => {
  document.documentElement
    .querySelectorAll('[data-paralume-owned="true"]')
    .forEach((element) => {
      element.remove();
    });
});

function runtime() {
  return {
    onMessage: { addListener: vi.fn() },
    sendMessage: vi.fn(() => Promise.resolve(undefined)),
  };
}

describe("automatic content bootstrap", () => {
  it("shows the floating menu by default on ordinary web pages", async () => {
    const storage = {
      local: {
        get: vi.fn(() => Promise.resolve({})),
        set: vi.fn(() => Promise.resolve()),
      },
    };

    await expect(
      bootstrapContentRuntime(
        document,
        location,
        {},
        {
          runtime: runtime(),
          storage,
          getUiLanguage: () => "en-US",
        },
      ),
    ).resolves.toBe(true);

    expect(
      document.querySelector('[data-paralume-owned="true"]'),
    ).not.toBeNull();
  });

  it("does not install on a site that the user disabled", async () => {
    const storage = {
      local: {
        get: vi.fn(() =>
          Promise.resolve({
            [DISABLED_SITES_STORAGE_KEY]: [location.hostname],
          }),
        ),
        set: vi.fn(() => Promise.resolve()),
      },
    };

    await expect(
      bootstrapContentRuntime(
        document,
        location,
        {},
        {
          runtime: runtime(),
          storage,
          getUiLanguage: () => "zh-CN",
        },
      ),
    ).resolves.toBe(false);

    expect(document.querySelector('[data-paralume-owned="true"]')).toBeNull();
  });
});
