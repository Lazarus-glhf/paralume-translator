import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { createBackgroundTranslationMessage } from "../src/messaging/protocol";
import type { ProviderPermissionsApi } from "../src/settings/permissions";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/repository";
import type { ProviderSettings } from "../src/settings/types";
import {
  createConfiguredProvider,
  createSettingsBackedProviderResolver,
} from "../src/translation/registry";

function settings(
  provider: ProviderSettings["provider"],
  withApiKeys = true,
): ProviderSettings {
  return {
    ...DEFAULT_PROVIDER_SETTINGS,
    provider,
    openai: {
      ...DEFAULT_PROVIDER_SETTINGS.openai,
      ...(withApiKeys ? { apiKey: "openai-key" } : {}),
    },
    microsoft: {
      ...DEFAULT_PROVIDER_SETTINGS.microsoft,
      ...(withApiKeys ? { apiKey: "microsoft-key" } : {}),
    },
  };
}

const grantedPermissions: ProviderPermissionsApi = {
  contains: vi.fn(() => Promise.resolve(true)),
  request: vi.fn(() => Promise.resolve(true)),
};

const operationId = "37d11119-1b61-4b44-84fe-e09a2bed91ab";

describe("translation provider registry", () => {
  it.each([
    ["mock", "Mock"],
    ["openai", "OpenAI-compatible"],
    ["microsoft", "Microsoft Translator"],
  ] as const)(
    "creates only the explicitly selected %s provider",
    (id, name) => {
      expect(createConfiguredProvider(settings(id)).name).toBe(name);
    },
  );

  it.each(["openai", "microsoft"] as const)(
    "does not fall back to Mock when %s has no API key",
    (provider) => {
      expect(() => createConfiguredProvider(settings(provider, false))).toThrow(
        /API key is not configured/u,
      );
    },
  );

  it("refuses a revoked exact-origin permission before provider use", async () => {
    const load = vi.fn(() => Promise.resolve(settings("openai")));
    const repository = { load };
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    const resolveProvider = createSettingsBackedProviderResolver(
      repository,
      permissions,
    );

    await expect(resolveProvider()).rejects.toMatchObject({
      code: "PERMISSION_MISSING",
    });
    expect(permissions.request).not.toHaveBeenCalled();
  });

  it("loads the current selected provider for every background request", async () => {
    const selected = settings("mock");
    const load = vi.fn(() => Promise.resolve(selected));
    const repository = { load };
    const resolveProvider = createSettingsBackedProviderResolver(
      repository,
      grantedPermissions,
    );
    const handler = createBackgroundMessageHandler(resolveProvider);

    await expect(
      handler(
        createBackgroundTranslationMessage(
          {
            sourceLanguage: "auto",
            targetLanguage: "zh-CN",
            segments: [{ id: "segment-a", text: "Readable paragraph." }],
          },
          operationId,
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      results: [
        {
          id: "segment-a",
          translatedText: "【Mock zh-CN】Readable paragraph.",
        },
      ],
    });
    expect(load).toHaveBeenCalledOnce();
  });

  it("wraps the selected background provider with the persisted retry policy", async () => {
    const selected = {
      ...settings("openai"),
      retry: { enabled: true, maxRetries: 2 },
    };
    const load = vi.fn(() => Promise.resolve(selected));
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValueOnce(new Response("temporary", { status: 503 }))
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              translations: [
                { id: "segment-a", translatedText: "后台重试成功" },
              ],
            }),
          }),
          { status: 200 },
        ),
      );
    const sleep = vi.fn(() => Promise.resolve());
    const resolveProvider = createSettingsBackedProviderResolver(
      { load },
      grantedPermissions,
      { fetch, retry: { sleep, random: () => 0.5 } },
    );
    const handler = createBackgroundMessageHandler(resolveProvider);

    await expect(
      handler(
        createBackgroundTranslationMessage(
          {
            sourceLanguage: "auto",
            targetLanguage: "zh-CN",
            segments: [{ id: "segment-a", text: "Readable paragraph." }],
          },
          operationId,
        ),
      ),
    ).resolves.toMatchObject({
      ok: true,
      results: [
        {
          id: "segment-a",
          status: "success",
          translatedText: "后台重试成功",
        },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});
