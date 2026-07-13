import { describe, expect, it, vi } from "vitest";

import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import { createBackgroundRouter } from "../src/messaging/background-router";
import {
  createSaveSettingsMessage,
  parseSettingsRequest,
  parseSettingsResponse,
} from "../src/messaging/settings-protocol";
import { createOptionsClient } from "../src/options/client";
import type { ProviderPermissionsApi } from "../src/settings/permissions";
import {
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
        message: "Loaded.",
        settings: {
          version: 1,
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
      message: "Provider connection test succeeded.",
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
      version: 1 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: false },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
    };
    const sendMessage = vi.fn((message: unknown) => {
      const command = (message as { command?: string }).command;
      events.push(`background:${command ?? "unknown"}`);
      return Promise.resolve({
        protocolVersion: 1,
        ok: true,
        message:
          command === "get" ? "Provider settings loaded." : "Settings saved.",
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

    await expect(saving).resolves.toMatchObject({ message: "Settings saved." });
    expect(events).toEqual(["request", "background:get", "background:save"]);
    expect(permissions.contains).not.toHaveBeenCalled();
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

  it("removes a stale exact origin after saving a changed endpoint", async () => {
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve(true)),
    };
    const oldSettings = {
      version: 1 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: true },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
    };
    const newDraft = {
      ...draft,
      openai: { ...draft.openai, baseUrl: "https://new.example.com/v1" },
    };
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: true,
        settings: oldSettings,
        message: "Loaded.",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: true,
        settings: {
          ...oldSettings,
          openai: { ...newDraft.openai, apiKeyConfigured: true },
        },
        message: "Saved.",
      });
    const client = createOptionsClient({ sendMessage }, permissions);

    await client.save(newDraft, {});

    expect(permissions.remove).toHaveBeenCalledWith({
      origins: ["https://api.example.com/*"],
    });
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ command: "get" }),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ command: "save" }),
    );
  });

  it("keeps saved settings and reports a fixed warning when old-origin removal fails", async () => {
    const permissions: ProviderPermissionsApi = {
      contains: vi.fn(() => Promise.resolve(true)),
      request: vi.fn(() => Promise.resolve(true)),
      remove: vi.fn(() => Promise.resolve(false)),
    };
    const oldSettings = {
      version: 1 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: true },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
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
        message: "Loaded.",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        ok: true,
        settings: savedSettings,
        message: "Saved.",
      });
    const client = createOptionsClient({ sendMessage }, permissions);

    await expect(client.save(newDraft, {})).resolves.toEqual({
      settings: savedSettings,
      message:
        "Provider settings were saved, but the previous provider permission could not be removed. Remove it from the browser extension settings.",
    });
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
      version: 1 as const,
      provider: "openai" as const,
      openai: { ...draft.openai, apiKeyConfigured: true },
      microsoft: { ...draft.microsoft, apiKeyConfigured: false },
    };
    const sendMessage = vi.fn((message: unknown) => {
      const command = (message as { command?: string }).command ?? "unknown";
      events.push(`background:${command}`);
      return Promise.resolve({
        protocolVersion: 1,
        ok: true,
        settings: loaded,
        message:
          command === "get"
            ? "Provider settings loaded."
            : "Provider connection test succeeded.",
      });
    });
    const client = createOptionsClient({ sendMessage }, permissions);
    await client.load();
    events.length = 0;

    const testing = client.testConnection();
    expect(events).toEqual(["request"]);
    await expect(testing).resolves.toMatchObject({
      message: "Provider connection test succeeded.",
    });
    expect(events).toEqual(["request", "background:test-connection"]);
    expect(permissions.contains).not.toHaveBeenCalled();
  });
});
