import { describe, expect, it } from "vitest";

import {
  formatMessage,
  resolveUiLocale,
  translateError,
} from "../src/localization";

describe("UI locale resolution", () => {
  it.each([
    ["en", "zh-CN", "en"],
    ["zh-CN", "en-US", "zh-CN"],
    ["system", "zh-CN", "zh-CN"],
    ["system", "zh-Hans-CN", "zh-CN"],
    ["system", "en-GB", "en"],
    ["system", "fr-FR", "en"],
    ["system", undefined, "en"],
  ] as const)(
    "resolves %s with browser language %s to %s",
    (setting, browserLanguage, expected) => {
      expect(resolveUiLocale(setting, browserLanguage)).toBe(expected);
    },
  );
});

describe("localized message catalog", () => {
  it("formats stable message identifiers with escaped-as-text values", () => {
    expect(
      formatMessage("en", "content.translationSummary", {
        succeeded: 2,
        failed: 1,
      }),
    ).toBe("Translated 2 readable blocks; 1 unavailable.");
    expect(
      formatMessage("zh-CN", "content.translationSummary", {
        succeeded: 2,
        failed: 1,
      }),
    ).toBe("已翻译 2 个可读文本块；1 个不可用。");
  });

  it("localizes every structured error by code without using its English message", () => {
    expect(translateError("en", "AUTHENTICATION_FAILED")).toBe(
      "The provider rejected the configured credentials.",
    );
    expect(translateError("zh-CN", "AUTHENTICATION_FAILED")).toBe(
      "翻译服务拒绝了已配置的凭据。",
    );
  });

  it("fails closed for unknown message identifiers at runtime", () => {
    expect(() => formatMessage("en", "unknown.message" as never)).toThrow();
  });
});
