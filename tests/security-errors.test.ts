import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import { createBackgroundTranslationMessage } from "../src/messaging/protocol";
import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import {
  SAFE_ERROR_MESSAGES,
  UserFacingError,
  createError,
  sanitizeError,
} from "../src/shared/errors";
import type { PublicProviderSettings } from "../src/settings/types";
import { DEFAULT_PROVIDER_SETTINGS } from "../src/settings/repository";
import { translateInBatches } from "../src/translation/batcher";

const operationId = "5175c2e7-6154-4503-86c4-2debb5fcb444";

const LEAK_SENTINELS = [
  "LEAK_SECRET_7c1d",
  "https://private-provider.invalid/account/42",
  "LEAK_PAGE_TEXT_91af",
] as const;

function hostileError(): Error {
  const [secret, url, pageText] = LEAK_SENTINELS;
  return new Error(`${secret} ${url} ${pageText}`, {
    cause: { credential: secret, responseBody: pageText },
  });
}

function expectNoLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const sentinel of LEAK_SENTINELS) {
    expect(serialized).not.toContain(sentinel);
  }
}

const publicSettings: PublicProviderSettings = {
  version: 2,
  provider: "mock",
  openai: {
    ...DEFAULT_PROVIDER_SETTINGS.openai,
    apiKeyConfigured: false,
  },
  microsoft: {
    ...DEFAULT_PROVIDER_SETTINGS.microsoft,
    apiKeyConfigured: false,
  },
  retry: { ...DEFAULT_PROVIDER_SETTINGS.retry },
  appearance: { ...DEFAULT_PROVIDER_SETTINGS.appearance },
  uiLanguage: DEFAULT_PROVIDER_SETTINGS.uiLanguage,
};

describe("safe cross-runtime errors", () => {
  it("defines fixed allowlisted messages for every reviewed provider failure", () => {
    const reviewedCodes = [
      "AUTHENTICATION_FAILED",
      "RATE_LIMITED",
      "REQUEST_TIMEOUT",
      "NETWORK_ERROR",
      "SERVER_UNAVAILABLE",
      "MALFORMED_JSON",
      "MALFORMED_PROVIDER_OUTPUT",
      "API_KEY_UNCONFIGURED",
      "PERMISSION_MISSING",
      "VALIDATION_ERROR",
    ] as const;
    for (const code of reviewedCodes) {
      expect(typeof SAFE_ERROR_MESSAGES[code]).toBe("string");
    }

    for (const code of Object.keys(
      SAFE_ERROR_MESSAGES,
    ) as (keyof typeof SAFE_ERROR_MESSAGES)[]) {
      expect(createError(code).message).toBe(SAFE_ERROR_MESSAGES[code]);
    }
  });

  it("preserves only explicitly typed user-facing errors", () => {
    expect(sanitizeError(new UserFacingError("RATE_LIMITED"))).toEqual(
      createError("RATE_LIMITED"),
    );
    const sanitized = sanitizeError(hostileError(), "TRANSLATION_FAILED");
    expect(sanitized).toEqual(createError("TRANSLATION_FAILED"));
    expectNoLeak(sanitized);
  });

  it("keeps provider exceptions request-wide until the background boundary sanitizes them", async () => {
    await expect(
      translateInBatches(
        {
          name: "hostile",
          translate: () => Promise.reject(hostileError()),
        },
        {
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          segments: [
            { id: "segment-a", text: "Sensitive source paragraph A." },
            { id: "segment-b", text: "Sensitive source paragraph B." },
          ],
        },
      ),
    ).rejects.toThrow();
  });

  it("sanitizes provider resolver exceptions in translation responses", async () => {
    const handle = createBackgroundMessageHandler(() =>
      Promise.reject(hostileError()),
    );
    const response = await handle(
      createBackgroundTranslationMessage(
        {
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          segments: [{ id: "segment-a", text: "Sensitive page paragraph." }],
        },
        operationId,
      ),
    );

    expect(response).toMatchObject({
      ok: false,
      error: createError("TRANSLATION_FAILED"),
    });
    expectNoLeak(response);
  });

  it("sanitizes request-wide provider exceptions without manufacturing segment results", async () => {
    const handle = createBackgroundMessageHandler({
      name: "hostile-provider",
      translate: () => Promise.reject(hostileError()),
    });
    const response = await handle(
      createBackgroundTranslationMessage(
        {
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          segments: [
            { id: "segment-a", text: "Sensitive page paragraph A." },
            { id: "segment-b", text: "Sensitive page paragraph B." },
          ],
        },
        operationId,
      ),
    );

    expect(response).toMatchObject({
      ok: false,
      error: createError("INTERNAL_ERROR"),
    });
    expect(response).not.toHaveProperty("results");
    expectNoLeak(response);
  });

  it("sanitizes settings repository and provider exceptions", async () => {
    const repository = {
      loadPublic: vi.fn(() => Promise.resolve(publicSettings)),
      loadContent: vi.fn(() =>
        Promise.resolve({
          retry: publicSettings.retry,
          appearance: publicSettings.appearance,
          uiLanguage: publicSettings.uiLanguage,
        }),
      ),
      save: vi.fn(() => Promise.reject(hostileError())),
      clearApiKey: vi.fn(() => Promise.reject(hostileError())),
    };
    const handle = createSettingsMessageHandler(repository, () =>
      Promise.reject(hostileError()),
    );
    const response = await handle({
      protocolVersion: 1,
      target: "settings",
      command: "clear-api-key",
      provider: "openai",
    });

    expect(response).toMatchObject({
      ok: false,
      error: createError("INTERNAL_ERROR"),
    });
    expectNoLeak(response);
  });

  it("sanitizes an unexpected listener rejection and does not log it", async () => {
    type Listener = (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    let listener: Listener | undefined;
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    registerBackgroundMessageListener(
      {
        addListener(next) {
          listener = next;
        },
      },
      () => Promise.reject(hostileError()),
    );
    const responses: unknown[] = [];
    const sendResponse = (response: unknown) => {
      responses.push(response);
    };

    expect(listener?.({}, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(responses).toHaveLength(1);
    });
    const response = responses[0];
    expect(response).toMatchObject({
      ok: false,
      error: createError("INTERNAL_ERROR"),
    });
    expectNoLeak(response);
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
