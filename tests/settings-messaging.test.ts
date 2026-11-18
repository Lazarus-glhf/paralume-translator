import { describe, expect, it, vi } from "vitest";

import { createSettingsMessageHandler } from "../src/messaging/settings-handler";
import { createBackgroundRouter } from "../src/messaging/background-router";
import { createExtensionPageSenderCheck } from "../src/messaging/sender";
import {
  createClearApiKeyMessage,
  createDisableSiteMessage,
  createGetContentSettingsMessage,
  createGetSettingsMessage,
  createGetSiteStateMessage,
  createOpenOptionsMessage,
  createSaveSettingsMessage,
  createTestConnectionMessage,
  parseContentSettingsResponse,
  parseDisableSiteResponse,
  parseSettingsRequest,
  parseSettingsResponse,
  parseSiteStateResponse,
} from "../src/messaging/settings-protocol";
import { createSitePreferenceStore } from "../src/settings/site-preferences";
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
import { createSettingsBackedProviderResolver } from "../src/translation/registry";

const grantedPermissions: ProviderPermissionsApi = {
  contains: vi.fn(() => Promise.resolve(true)),
  request: vi.fn(() => Promise.resolve(true)),
};

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

function createKeyedStorage(): SettingsStorageArea & {
  readonly set: ReturnType<typeof vi.fn>;
} {
  const stored = new Map<string, unknown>();
  return {
    get: vi.fn((key: string) =>
      Promise.resolve(stored.has(key) ? { [key]: stored.get(key) } : {}),
    ),
    set: vi.fn((items: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(items)) {
        stored.set(key, value);
      }
      return Promise.resolve();
    }),
  };
}

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const isExtensionPageSender = createExtensionPageSenderCheck(
  EXTENSION_ID,
  `chrome-extension://${EXTENSION_ID}/`,
);
// Shapes Chromium reports for runtime.sendMessage senders.
const optionsSender = {
  context: {
    sender: {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/options.html`,
      origin: `chrome-extension://${EXTENSION_ID}`,
    },
  },
};
const contentScriptSender = {
  context: {
    sender: {
      id: EXTENSION_ID,
      url: "https://news.example.com/articles/1?ref=home",
      origin: "https://news.example.com",
      tab: { id: 7 },
      frameId: 0,
    },
  },
};

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
    {
      protocolVersion: 1,
      target: "settings",
      command: "open-options",
      url: "https://attacker.example/",
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
    const handler = createSettingsMessageHandler(
      repository,
      () => Promise.resolve(new MockTranslationProvider()),
      { isExtensionPageSender },
    );

    const saved = await handler(
      createSaveSettingsMessage(draft, {
        openaiApiKey: "background-only-test-key",
      }),
      optionsSender.context,
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
    const handler = createSettingsMessageHandler(
      repository,
      () => Promise.resolve(new MockTranslationProvider()),
      { isExtensionPageSender },
    );

    const response = await handler(
      createGetContentSettingsMessage(),
      contentScriptSender.context,
    );
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

  it("opens Options for the page control without returning settings data", async () => {
    const openOptionsPage = vi.fn(() => Promise.resolve());
    const handler = createSettingsMessageHandler(
      createSettingsRepository(createStorage()),
      () => Promise.resolve(new MockTranslationProvider()),
      { openOptionsPage, isExtensionPageSender },
    );

    await expect(
      handler(createOpenOptionsMessage(), contentScriptSender.context),
    ).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
    });
    expect(openOptionsPage).toHaveBeenCalledOnce();
    await expect(
      handler({ ...createOpenOptionsMessage(), extra: true }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
    expect(openOptionsPage).toHaveBeenCalledOnce();

    const withoutOpener = createSettingsMessageHandler(
      createSettingsRepository(createStorage()),
      () => Promise.resolve(new MockTranslationProvider()),
    );
    await expect(
      withoutOpener(createOpenOptionsMessage()),
    ).resolves.toMatchObject({ ok: false, error: { code: "INTERNAL_ERROR" } });
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
    const handler = createSettingsMessageHandler(
      repository,
      () => Promise.resolve({ name: "Selected provider", translate }),
      { isExtensionPageSender },
    );

    await expect(
      handler(
        {
          protocolVersion: 1,
          target: "settings",
          command: "test-connection",
        },
        optionsSender.context,
      ),
    ).resolves.toMatchObject({
      ok: true,
      message: { id: "settings.testSucceeded" },
    });
    expect(translate).toHaveBeenCalledOnce();
  });

  it("tests the streaming path that page translation uses", async () => {
    const result = {
      id: "paralume-connection-test",
      status: "success" as const,
      translatedText: "连接成功",
    };
    const translate = vi.fn(() => Promise.resolve([result]));
    const streamTranslate = vi.fn(() => Promise.resolve([result]));
    const handler = createSettingsMessageHandler(
      createSettingsRepository(createStorage()),
      () => Promise.resolve({ name: "Streaming", translate, streamTranslate }),
      { isExtensionPageSender },
    );

    await expect(
      handler(createTestConnectionMessage(), optionsSender.context),
    ).resolves.toMatchObject({ ok: true });
    expect(streamTranslate).toHaveBeenCalledOnce();
    expect(translate).not.toHaveBeenCalled();
  });

  describe("OpenAI Responses connection test", () => {
    const output = JSON.stringify({ t: [{ i: "0", v: "连接测试" }] });

    async function testWith(response: () => Response) {
      const repository = createSettingsRepository(createStorage());
      await repository.save(draft, { openaiApiKey: "connection-test-key" });
      const bodies: unknown[] = [];
      const fetch = vi.fn((_url: string, init?: RequestInit) => {
        bodies.push(init?.body);
        return Promise.resolve(response());
      });
      const handler = createSettingsMessageHandler(
        repository,
        createSettingsBackedProviderResolver(repository, grantedPermissions, {
          fetch,
        }),
        { isExtensionPageSender },
      );
      const reply = await handler(
        createTestConnectionMessage(),
        optionsSender.context,
      );
      const body = bodies[0];
      return {
        reply,
        calls: bodies.length,
        body: JSON.parse(typeof body === "string" ? body : "null") as unknown,
      };
    }

    it("fails when the endpoint ignores streaming, as page translation would", async () => {
      // Answers with a complete non-streaming JSON body. The old test used
      // the non-streaming request and passed against such an endpoint.
      const { reply, calls, body } = await testWith(
        () =>
          new Response(JSON.stringify({ output_text: output }), {
            headers: { "content-type": "application/json" },
          }),
      );

      expect(reply).toMatchObject({
        ok: false,
        error: { code: "MALFORMED_PROVIDER_OUTPUT" },
      });
      expect(calls).toBe(1);
      expect(body).toMatchObject({ stream: true, store: false });
    });

    it("succeeds against an endpoint that streams", async () => {
      const event = JSON.stringify({
        type: "response.output_text.delta",
        delta: output,
      });
      const { reply, body } = await testWith(
        () =>
          new Response(`data: ${event}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );

      expect(reply).toMatchObject({
        ok: true,
        message: { id: "settings.testSucceeded" },
      });
      expect(body).toMatchObject({ stream: true, store: false });
    });
  });

  it("tells Options when an origin change removed the saved key", async () => {
    const repository = createSettingsRepository(createStorage());
    const handler = createSettingsMessageHandler(
      repository,
      () => Promise.resolve(new MockTranslationProvider()),
      { isExtensionPageSender },
    );
    await handler(
      createSaveSettingsMessage(draft, { openaiApiKey: "origin-a-test-key" }),
      optionsSender.context,
    );

    const moved = await handler(
      createSaveSettingsMessage(
        {
          ...draft,
          openai: { ...draft.openai, baseUrl: "https://relay.example.net/v1" },
        },
        {},
      ),
      optionsSender.context,
    );

    expect(parseSettingsResponse(moved)).toMatchObject({
      ok: true,
      value: {
        ok: true,
        message: { id: "settings.savedApiKeyRemoved" },
        settings: { openai: { apiKeyConfigured: false } },
      },
    });
    expect((await repository.load()).openai.apiKey).toBeUndefined();
    expect(JSON.stringify(moved)).not.toContain("origin-a-test-key");
  });
});

describe("settings sender authorization", () => {
  const privilegedMessages = [
    createGetSettingsMessage(),
    createSaveSettingsMessage(
      {
        ...draft,
        openai: { ...draft.openai, baseUrl: "https://attacker.example/v1" },
      },
      {},
    ),
    createClearApiKeyMessage("openai"),
    createTestConnectionMessage(),
  ];

  async function seededHandler(
    dependencies: Parameters<typeof createSettingsMessageHandler>[2],
  ) {
    const base = createStorage();
    const set = vi.fn((items: Record<string, unknown>) => base.set(items));
    const repository = createSettingsRepository({
      get: (key) => base.get(key),
      set,
    });
    await repository.save(draft, { openaiApiKey: "kept-test-key" });
    set.mockClear();
    const translate = vi.fn(() => Promise.resolve([]));
    const handler = createSettingsMessageHandler(
      repository,
      () => Promise.resolve({ name: "Paid provider", translate }),
      dependencies,
    );
    return { handler, repository, set, translate };
  }

  it.each(privilegedMessages)(
    "rejects a content-script sender for $command without touching settings",
    async (message) => {
      const { handler, repository, set, translate } = await seededHandler({
        isExtensionPageSender,
      });

      const response = await handler(message, contentScriptSender.context);

      expect(response).toMatchObject({
        ok: false,
        error: { code: "INVALID_MESSAGE" },
      });
      expect(response).not.toHaveProperty("settings");
      expect(set).not.toHaveBeenCalled();
      expect(translate).not.toHaveBeenCalled();
      const stored = await repository.load();
      expect(stored.openai.baseUrl).toBe(draft.openai.baseUrl);
      expect(stored.openai.apiKey).toBe("kept-test-key");
    },
  );

  it.each(privilegedMessages)(
    "fails closed for $command without a sender policy or sender",
    async (message) => {
      const unconfigured = await seededHandler({});
      await expect(
        unconfigured.handler(message, optionsSender.context),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_MESSAGE" },
      });

      const configured = await seededHandler({ isExtensionPageSender });
      await expect(configured.handler(message)).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_MESSAGE" },
      });
      expect(configured.set).not.toHaveBeenCalled();
      expect(configured.translate).not.toHaveBeenCalled();
    },
  );

  it("accepts the same privileged commands from an extension page", async () => {
    const { handler } = await seededHandler({ isExtensionPageSender });

    await expect(
      handler(createGetSettingsMessage(), optionsSender.context),
    ).resolves.toMatchObject({ ok: true, message: { id: "settings.loaded" } });
    await expect(
      handler(createClearApiKeyMessage("openai"), optionsSender.context),
    ).resolves.toMatchObject({
      ok: true,
      settings: { openai: { apiKeyConfigured: false } },
    });
  });

  it("recognizes only this extension's own page URLs", () => {
    const base = `chrome-extension://${EXTENSION_ID}`;
    expect(isExtensionPageSender(optionsSender.context.sender)).toBe(true);
    expect(
      isExtensionPageSender({ id: EXTENSION_ID, url: `${base}/popup.html` }),
    ).toBe(true);
    for (const sender of [
      contentScriptSender.context.sender,
      { id: EXTENSION_ID },
      { id: EXTENSION_ID, url: `${base}x/options.html` },
      { id: EXTENSION_ID, url: base },
      { id: "another-extension-id", url: `${base}/options.html` },
      { url: `${base}/options.html` },
      { id: EXTENSION_ID, url: 42 },
      undefined,
      null,
      "options",
    ]) {
      expect(isExtensionPageSender(sender)).toBe(false);
    }
  });
});

describe("floating menu site preference messages", () => {
  function siteHandler() {
    const storage = createKeyedStorage();
    const sitePreferences = createSitePreferenceStore(storage);
    const handler = createSettingsMessageHandler(
      createSettingsRepository(storage),
      () => Promise.resolve(new MockTranslationProvider()),
      { isExtensionPageSender, sitePreferences },
    );
    return { handler, sitePreferences, storage };
  }

  it("reads and disables only the sender's own site", async () => {
    const { handler, sitePreferences } = siteHandler();

    await expect(
      handler(createGetSiteStateMessage(), contentScriptSender.context),
    ).resolves.toEqual({ protocolVersion: 1, ok: true, siteDisabled: false });
    await expect(
      handler(createDisableSiteMessage(), contentScriptSender.context),
    ).resolves.toEqual({ protocolVersion: 1, ok: true });

    await expect(sitePreferences.isDisabled("news.example.com")).resolves.toBe(
      true,
    );
    await expect(
      handler(createGetSiteStateMessage(), contentScriptSender.context),
    ).resolves.toEqual({ protocolVersion: 1, ok: true, siteDisabled: true });
    const otherSite = {
      sender: { ...contentScriptSender.context.sender, url: "https://b.test/" },
    };
    await expect(
      handler(createGetSiteStateMessage(), otherSite),
    ).resolves.toEqual({ protocolVersion: 1, ok: true, siteDisabled: false });
  });

  it("rejects a message-supplied site and senders without a web URL", async () => {
    const { handler, storage } = siteHandler();

    await expect(
      handler(
        { ...createDisableSiteMessage(), site: "victim.example" },
        contentScriptSender.context,
      ),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
    await expect(
      handler(createDisableSiteMessage(), optionsSender.context),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
    await expect(handler(createGetSiteStateMessage())).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_MESSAGE" },
    });
    expect(storage.set).not.toHaveBeenCalled();
  });

  it("validates site responses strictly", () => {
    expect(
      parseSiteStateResponse({
        protocolVersion: 1,
        ok: true,
        siteDisabled: "yes",
      }).ok,
    ).toBe(false);
    expect(
      parseSiteStateResponse({
        protocolVersion: 1,
        ok: true,
        siteDisabled: false,
        settings: {},
      }).ok,
    ).toBe(false);
    expect(
      parseDisableSiteResponse({ protocolVersion: 1, ok: true, extra: 1 }).ok,
    ).toBe(false);
    expect(parseDisableSiteResponse({ protocolVersion: 1, ok: true })).toEqual({
      ok: true,
      value: { protocolVersion: 1, ok: true },
    });
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
