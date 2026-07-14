import { describe, expect, it, vi } from "vitest";

import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import { createBackgroundRouter } from "../src/messaging/background-router";
import {
  createGetContentSettingsMessage,
  createSaveSettingsMessage,
  parseContentSettingsResponse,
  parseSettingsRequest,
  parseSettingsResponse,
} from "../src/messaging/settings-protocol";
import { createOptionsClient } from "../src/options/client";
import type { ProviderPermissionsApi } from "../src/settings/permissions";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
  SETTINGS_STORAGE_KEY,
  createSettingsRepository,
  type SettingsStorageArea,
} from "../src/settings/repository";
import type { ProviderSettingsDraft } from "../src/settings/types";
import { MockTranslationProvider } from "../src/translation/mock";

const draft: ProviderSettingsDraft = {
  provider: "openai",
  openai: {
    baseUrl: "https://api.example.com/v1",
    model: "translation-model",
    protocol: "responses",
    reasoningEffort: "low",
  },
  microsoft: {
    endpoint: "https://api.cognitive.microsofttranslator.com",
    region: "global",
  },
  retry: DEFAULT_RETRY_SETTINGS,
  appearance: DEFAULT_APPEARANCE_SETTINGS,
  uiLanguage: "system",
};

function createStorage(): SettingsStorageArea {
  let stored: unknown;
  return {
    get: vi.fn(() =>
      Promise.resolve(
        stored === undefined ? {} : { [SETTINGS_STORAGE_KEY]: stored },
      ),
    ),
    set: vi.fn((items: Record<string, unknown>) => {
      stored = items[SETTINGS_STORAGE_KEY];
      return Promise.resolve();
    }),
  };
}

describe("settings runtime protocol", () => {
  it.each([
    null,
    {},
    { protocolVersion: 1, target: "settings", command: "save" },
    {
      protocolVersion: 1,
      target: "settings",
      command: "clear-api-key",
      provider: "mock",
    },
    {
      protocolVersion: 1,
      target: "settings",
      command: "get",
      unexpected: true,
    },
  ])("rejects a malformed settings request: %j", (message) => {
    expect(parseSettingsRequest(message).ok).toBe(false);
  });

  it("rejects a settings response that attempts to expose an API key", () => {
    expect(
      parseSettingsResponse({
        protocolVersion: 1,
        ok: true,
        message: { id: "settings.loaded" },
        settings: {
          version: 2,
          provider: "openai",
          openai: {
            ...draft.openai,
            apiKey: "must-not-cross-the-boundary",
            apiKeyConfigured: true,
          },
          microsoft: {
            ...draft.microsoft,
            apiKeyConfigured: false,
          },
          retry: draft.retry,
          appearance: draft.appearance,
          uiLanguage: draft.uiLanguage,
        },
      }).ok,
    ).toBe(false);
  });

  it("stores a submitted key in background storage without returning it", async () => {
    const repository = createSettingsRepository(createStorage());
    const handler = createSettingsMessageHandler(repository, () =>
      Promise.resolve(new MockTranslationProvider()),
    );

    const saved = await handler(
      createSaveSettingsMessage(draft, {
        openaiApiKey: "background-only-test-key",
      }),
    );
    expect(saved).toMatchObject({
      ok: true,
      settings: { openai: { apiKeyConfigured: true } },
    });
    expect(JSON.stringify(saved)).not.toContain("background-only-test-key");
    expect(JSON.stringify(saved)).not.toContain('"apiKey"');

    const stored = await repository.load();
    expect(stored.openai.apiKey).toBe("background-only-test-key");
  });

  it("returns only non-sensitive content settings for injected page code", async () => {
    const repository = createSettingsRepository(createStorage());
    await repository.save(
      { ...draft, uiLanguage: "zh-CN" },
      { openaiApiKey: "content-must-not-see-this-key" },
    );
    const handler = createSettingsMessageHandler(repository, () =>
      Promise.resolve(new MockTranslationProvider()),
    );

    const response = await handler(createGetContentSettingsMessage());
    expect(parseContentSettingsResponse(response)).toEqual({
      ok: true,
      value: {
        protocolVersion: 1,
        ok: true,
        contentSettings: {
          retry: draft.retry,
          appearance: draft.appearance,
          uiLanguage: "zh-CN",
        },
      },
    });
    expect(JSON.stringify(response)).not.toMatch(
      /content-must-not-see|apiKey|baseUrl|endpoint|provider/u,
    );
  });

  it("runs the selected provider connection test in the background", async () => {
    const repository = createSettingsRepository(createStorage());
    const translate = vi.fn(() =>
      Promise.resolve([
        {
          id: "paralume-connection-test",
          status: "success" as const,
          translatedText: "连接成功",
        },
      ]),
    );
    const handler = createSettingsMessageHandler(repository, () =>
      Promise.resolve({ name: "Selected provider", translate }),
    );

    await expect(
      handler({
        protocolVersion: 1,
        target: "settings",
        command: "test-connection",
      }),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: "settings.testSucceeded" },
    });
    expect(translate).toHaveBeenCalledOnce();
  });
});

describe("background runtime router", () => {
  it("routes only settings-target messages to the settings handler", async () => {
    const translationHandler = vi.fn(() => Promise.resolve("translation"));
    const settingsHandler = vi.fn(() => Promise.resolve("settings"));
    const router = createBackgroundRouter(translationHandler, settingsHandler);

    await expect(
      router({ protocolVersion: 1, target: "settings", command: "get" }),
    ).resolves.toBe("settings");
    await expect(
      router({
        protocolVersion: 1,
        target: "background",
        command: "translate",
      }),
    ).resolves.toBe("translation");
    expect(settingsHandler).toHaveBeenCalledOnce();
    expect(translationHandler).toHaveBeenCalledOnce();
  });
});

describe("Options settings client", () => {
  it("initiates the exact-origin request synchronously before any background or contains call", async () => {
    const events: string[] = [];
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => {
        events.push("contains");
        return Promise.resolve(false);
      }),
      request: vi.fn(() => {
        events.push("request");
        return Promise.resolve(true);
      }),
    };
    const publicSettings = {
      version: 2 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: false },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
      retry: draft.retry,
      appearance: draft.appearance,
      uiLanguage: draft.uiLanguage,
    };
    const sendMessage = vi.fn((message: unknown) => {
      const command = (message as { command?: string }).command;
      events.push(`background:${command ?? "unknown"}`);
      return Promise.resolve({
        protocolVersion: 1,
        ok: true,
        message: {
          id: command === "get" ? "settings.loaded" : "settings.saved",
        },
        settings:
          command === "get"
            ? publicSettings
            : {
                ...publicSettings,
                openai: { ...publicSettings.openai, apiKeyConfigured: true },
              },
      });
    });
    const client = createOptionsClient({ sendMessage }, permissions);

    const saving = client.save(draft, {
      openaiApiKey: "submitted-test-key",
    });
    expect(events).toEqual(["request"]);

    await expect(saving).resolves.toMatchObject({
      message: { id: "settings.saved" },
    });
    expect(events).toEqual([
      "request",
      "contains",
      "background:get",
      "background:save",
    ]);
    expect(permissions.contains).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(permissions.request).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      createSaveSettingsMessage(draft, {
        openaiApiKey: "submitted-test-key",
      }),
    );
  });

  it("rejects an insecure endpoint before requesting permission or messaging", async () => {
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(true)),
    };
    const sendMessage = vi.fn();
    const client = createOptionsClient({ sendMessage }, permissions);

    await expect(
      client.save(
        {
          ...draft,
          openai: { ...draft.openai, baseUrl: "http://api.example.com/v1" },
        },
        {},
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(permissions.request).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not send settings or credentials when exact-origin permission is denied", async () => {
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(false)),
    };
    const sendMessage = vi.fn();
    const client = createOptionsClient({ sendMessage }, permissions);

    await expect(
      client.save(draft, { openaiApiKey: "denied-credential-marker" }),
    ).rejects.toMatchObject({ code: "PERMISSION_MISSING" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("rolls back a newly granted origin when saving settings fails", async () => {
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(false)),
      request: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve(true)),
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: true,
        settings: {
          version: 2,
          provider: "mock",
          openai: { ...draft.openai, apiKeyConfigured: false },
          microsoft: { ...draft.microsoft, apiKeyConfigured: false },
          retry: draft.retry,
          appearance: draft.appearance,
          uiLanguage: draft.uiLanguage,
        },
        message: { id: "settings.loaded" },
      })
      .mockRejectedValueOnce(new Error("save transport failed"));
    const client = createOptionsClient({ sendMessage }, permissions);

    await expect(client.save(draft, {})).rejects.toBeDefined();
    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
  });

  it("keeps the fixed install-time web permissions when an endpoint changes", async () => {
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve(true)),
    };
    const oldSettings = {
      version: 2 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: true },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
      retry: draft.retry,
      appearance: draft.appearance,
      uiLanguage: draft.uiLanguage,
    };
    const newDraft = {
      ...draft,
      openai: { ...draft.openai, baseUrl: "https://new.example.com/v1" },
    };
    const savedSettings = {
      ...oldSettings,
      openai: { ...newDraft.openai, apiKeyConfigured: true },
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: true,
        settings: oldSettings,
        message: { id: "settings.loaded" },
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: true,
        settings: savedSettings,
        message: { id: "settings.saved" },
      });
    const client = createOptionsClient({ sendMessage }, permissions);

    await expect(client.save(newDraft, {})).resolves.toEqual({
      settings: savedSettings,
      message: { id: "settings.saved" },
    });
    expect(permissions.remove).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "get" }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "save" }),
    );
  });

  it("initiates Test connection permission directly from the loaded click path", async () => {
    const events: string[] = [];
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => {
        events.push("contains");
        return Promise.resolve(false);
      }),
      request: vi.fn(() => {
        events.push("request");
        return Promise.resolve(true);
      }),
    };
    const loaded = {
      version: 2 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: true },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
      retry: draft.retry,
      appearance: draft.appearance,
      uiLanguage: draft.uiLanguage,
    };
    const sendMessage = vi.fn((message: unknown) => {
      const command = (message as { command?: string }).command ?? "unknown";
      events.push(`background:${command}`);
      return Promise.resolve({
        protocolVersion: 1,
        ok: true,
        settings: loaded,
        message: {
          id: command === "get" ? "settings.loaded" : "settings.testSucceeded",
        },
      });
    });
    const client = createOptionsClient({ sendMessage }, permissions);
    await client.load();
    events.length = 0;

    const testing = client.testConnection();
    expect(events).toEqual(["request"]);
    await expect(testing).resolves.toMatchObject({
      message: { id: "settings.testSucceeded" },
    });
    expect(events).toEqual(["request", "background:test-connection"]);
    expect(permissions.contains).not.toHaveBeenCalled();
  });
});
