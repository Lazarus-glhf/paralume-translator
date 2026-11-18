import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { createBackgroundTranslationMessage } from "../src/messaging/protocol";
import type { ProviderPermissionsApi } from "../src/settings/permissions";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/repository";
import type { ProviderSettings } from "../src/settings/types";
import type { TranslationResult } from "../src/shared/types";
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

describe("production streaming path automatic retry", () => {
  const streamOperationId = "8a0f3a8e-7f0c-4a4f-9d55-3b2f9d1c0e11";
  const segments = [
    { id: "segment-a", text: "First readable paragraph." },
    { id: "segment-b", text: "Second readable paragraph." },
  ];
  const compactOutput = JSON.stringify({
    t: [
      { i: "0", v: "第一段" },
      { i: "1", v: "第二段" },
    ],
  });
  type FetchMock = (url: string, init?: RequestInit) => Promise<Response>;

  function sseResponse(deltas: readonly string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const delta of deltas) {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "response.output_text.delta", delta })}\n\n`,
            ),
          );
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }

  function chatResponse(): Response {
    return new Response(
      JSON.stringify({ choices: [{ message: { content: compactOutput } }] }),
      { status: 200 },
    );
  }

  function openAiSettings(
    protocol: "responses" | "chat-completions",
    retry: ProviderSettings["retry"],
  ): ProviderSettings {
    const base = settings("openai");
    return { ...base, openai: { ...base.openai, protocol }, retry };
  }

  function createStreamingHandler(
    selected: ProviderSettings,
    fetch: FetchMock,
  ) {
    const sleep = vi.fn(() => Promise.resolve());
    const sendResult =
      vi.fn<
        (
          sender: { tab: { id: number } },
          operationId: string,
          result: TranslationResult,
        ) => void
      >();
    const resolveProvider = createSettingsBackedProviderResolver(
      { load: () => Promise.resolve(selected) },
      grantedPermissions,
      { fetch, retry: { sleep, random: () => 0.5 } },
    );
    // Mirrors entrypoints/background.ts: sendResult is always supplied there,
    // so the batcher selects streamTranslate for every page translation.
    const handler = createBackgroundMessageHandler<{ tab: { id: number } }>(
      resolveProvider,
      undefined,
      undefined,
      { sendResult },
    );
    const translate = () =>
      handler(
        createBackgroundTranslationMessage(
          { sourceLanguage: "auto", targetLanguage: "zh-CN", segments },
          streamOperationId,
        ),
        { sender: { tab: { id: 7 } } },
      );
    return { sleep, sendResult, translate };
  }

  it("retries Responses streaming after two recoverable failures (3 attempts)", async () => {
    const fetch = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(
        sseResponse([compactOutput.slice(0, 17), compactOutput.slice(17)]),
      );
    const { sleep, sendResult, translate } = createStreamingHandler(
      openAiSettings("responses", { enabled: true, maxRetries: 2 }),
      fetch,
    );

    await expect(translate()).resolves.toMatchObject({
      ok: true,
      results: [
        { id: "segment-a", status: "success", translatedText: "第一段" },
        { id: "segment-b", status: "success", translatedText: "第二段" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetch.mock.calls) {
      expect(url).toMatch(/\/responses$/u);
      const body = init?.body;
      expect(typeof body).toBe("string");
      expect(JSON.parse(body as string)).toMatchObject({ stream: true });
    }
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sendResult.mock.calls.map((call) => call[2])).toEqual([
      { id: "segment-a", status: "success", translatedText: "第一段" },
      { id: "segment-b", status: "success", translatedText: "第二段" },
    ]);
  });

  it("retries Chat Completions page translation once after a recoverable failure (2 attempts)", async () => {
    const fetch = vi
      .fn<FetchMock>()
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(chatResponse());
    const { sleep, translate } = createStreamingHandler(
      openAiSettings("chat-completions", { enabled: true, maxRetries: 2 }),
      fetch,
    );

    await expect(translate()).resolves.toMatchObject({
      ok: true,
      results: [
        { id: "segment-a", status: "success", translatedText: "第一段" },
        { id: "segment-b", status: "success", translatedText: "第二段" },
      ],
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]?.[0]).toMatch(/\/chat\/completions$/u);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it.each(["responses", "chat-completions"] as const)(
    "does not retry %s page translation when automatic retry is disabled",
    async (protocol) => {
      const fetch = vi
        .fn<FetchMock>()
        .mockResolvedValue(new Response("busy", { status: 503 }));
      const { sleep, translate } = createStreamingHandler(
        openAiSettings(protocol, { enabled: false, maxRetries: 2 }),
        fetch,
      );

      await expect(translate()).resolves.toMatchObject({
        ok: false,
        error: { code: "SERVER_UNAVAILABLE" },
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );

  it.each(["responses", "chat-completions"] as const)(
    "never retries permanent %s failures on the page translation path",
    async (protocol) => {
      const fetch = vi
        .fn<FetchMock>()
        .mockResolvedValue(new Response("denied", { status: 401 }));
      const { sleep, translate } = createStreamingHandler(
        openAiSettings(protocol, { enabled: true, maxRetries: 2 }),
        fetch,
      );

      await expect(translate()).resolves.toMatchObject({
        ok: false,
        error: { code: "AUTHENTICATION_FAILED" },
      });
      expect(fetch).toHaveBeenCalledOnce();
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});
