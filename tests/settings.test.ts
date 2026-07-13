import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
  SETTINGS_STORAGE_KEY,
  createSettingsRepository,
  type SettingsStorageArea,
} from "../src/settings/repository";
import {
  deriveHttpsOriginPattern,
  validateAppearanceSettings,
  validateProviderSettingsDraft,
} from "../src/settings/validation";
import type { ProviderSettingsDraft } from "../src/settings/types";

function createStorage(initial?: unknown): SettingsStorageArea & {
  readonly set: ReturnType<typeof vi.fn>;
} {
  let stored = initial;

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

const validDraft: ProviderSettingsDraft = {
  provider: "openai",
  openai: {
    baseUrl: "https://api.example.com/v1/",
    model: "translation-model",
    protocol: "responses",
    reasoningEffort: "low",
  },
  microsoft: {
    endpoint: "https://api.cognitive.microsofttranslator.com/",
    region: "eastasia",
  },
  retry: { enabled: true, maxRetries: 2 },
  appearance: {
    fontFamily: "system",
    fontSize: 16,
    textColor: "#456257",
    backgroundColor: "#f4f8f5",
    lineHeight: 1.6,
    opacity: 1,
    verticalSpacing: 8,
  },
  uiLanguage: "system",
};

describe("provider settings validation", () => {
  it("normalizes HTTPS endpoints and derives one exact origin pattern", () => {
    const settings = validateProviderSettingsDraft(validDraft);

    expect(settings.openai.baseUrl).toBe("https://api.example.com/v1");
    expect(settings.microsoft.endpoint).toBe(
      "https://api.cognitive.microsofttranslator.com",
    );
    expect(deriveHttpsOriginPattern(settings.openai.baseUrl)).toBe(
      "https://api.example.com/*",
    );
  });

  it.each([
    "http://api.example.com/v1",
    "ftp://api.example.com/v1",
    "not a URL",
    "https://user:password@api.example.com/v1",
    "https://api.example.com/v1?key=value",
    "https://api.example.com/v1#fragment",
  ])("rejects an invalid OpenAI-compatible base URL: %s", (baseUrl) => {
    expect(() =>
      validateProviderSettingsDraft({
        ...validDraft,
        openai: { ...validDraft.openai, baseUrl },
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("requires non-empty model and region values", () => {
    expect(() =>
      validateProviderSettingsDraft({
        ...validDraft,
        openai: { ...validDraft.openai, model: "   " },
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    expect(() =>
      validateProviderSettingsDraft({
        ...validDraft,
        microsoft: { ...validDraft.microsoft, region: "" },
      }),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });

  it("normalizes safe appearance values and clamps every bounded number", () => {
    expect(
      validateAppearanceSettings({
        fontFamily: "serif",
        fontSize: 100,
        textColor: "#AbC",
        backgroundColor: "#FfFfFf",
        lineHeight: 0.1,
        opacity: 10,
        verticalSpacing: -20,
      }),
    ).toEqual({
      fontFamily: "serif",
      fontSize: 32,
      textColor: "#aabbcc",
      backgroundColor: "#ffffff",
      lineHeight: 1,
      opacity: 1,
      verticalSpacing: 0,
    });
  });

  it.each([
    { fontFamily: "serif; color: red" },
    { textColor: "red" },
    { backgroundColor: "url(https://attacker.invalid/pixel)" },
    { opacity: Number.NaN },
  ])("rejects unsafe appearance input: %j", (override) => {
    expect(() =>
      validateAppearanceSettings({
        ...DEFAULT_APPEARANCE_SETTINGS,
        ...override,
      } as never),
    ).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
  });
});

describe("versioned settings repository", () => {
  it("loads migration-safe Mock defaults from empty storage", async () => {
    const repository = createSettingsRepository(createStorage());

    await expect(repository.load()).resolves.toEqual(DEFAULT_PROVIDER_SETTINGS);
    await expect(repository.loadPublic()).resolves.toMatchObject({
      version: 2,
      provider: "mock",
      retry: DEFAULT_RETRY_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      uiLanguage: "system",
      openai: { apiKeyConfigured: false },
      microsoft: { apiKeyConfigured: false },
    });
  });

  it("migrates v1 settings in place while preserving provider configuration and API keys", async () => {
    const storage = createStorage({
      version: 1,
      provider: "microsoft",
      openai: {
        baseUrl: "https://compatible.example/v1",
        model: "kept-model",
        protocol: "chat-completions",
        reasoningEffort: "medium",
        apiKey: "kept-openai-key",
      },
      microsoft: {
        endpoint: "https://translator.example",
        region: "eastasia",
        apiKey: "kept-microsoft-key",
      },
    });
    const repository = createSettingsRepository(storage);

    await expect(repository.load()).resolves.toEqual({
      version: 2,
      provider: "microsoft",
      openai: {
        baseUrl: "https://compatible.example/v1",
        model: "kept-model",
        protocol: "chat-completions",
        reasoningEffort: "medium",
        apiKey: "kept-openai-key",
      },
      microsoft: {
        endpoint: "https://translator.example",
        region: "eastasia",
        apiKey: "kept-microsoft-key",
      },
      retry: DEFAULT_RETRY_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      uiLanguage: "system",
    });
    expect(storage.set).toHaveBeenCalledOnce();

    const publicSettings = await repository.loadPublic();
    expect(publicSettings).toMatchObject({
      version: 2,
      openai: { apiKeyConfigured: true },
      microsoft: { apiKeyConfigured: true },
    });
    expect(JSON.stringify(publicSettings)).not.toContain("kept-openai-key");
    expect(JSON.stringify(publicSettings)).not.toContain("kept-microsoft-key");
  });

  it("stores keys but never exposes them through the public settings view", async () => {
    const storage = createStorage();
    const repository = createSettingsRepository(storage);

    await repository.save(validDraft, {
      openaiApiKey: "openai-test-key",
      microsoftApiKey: "microsoft-test-key",
    });

    const stored = await repository.load();
    expect(stored.openai.apiKey).toBe("openai-test-key");
    expect(stored.microsoft.apiKey).toBe("microsoft-test-key");

    const publicSettings = await repository.loadPublic();
    expect(publicSettings.openai.apiKeyConfigured).toBe(true);
    expect(publicSettings.microsoft.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(publicSettings)).not.toContain("openai-test-key");
    expect(JSON.stringify(publicSettings)).not.toContain("microsoft-test-key");
    expect(JSON.stringify(publicSettings)).not.toContain('"apiKey"');
  });

  it("preserves existing keys unless a replacement is explicitly supplied", async () => {
    const storage = createStorage({
      ...DEFAULT_PROVIDER_SETTINGS,
      openai: {
        ...DEFAULT_PROVIDER_SETTINGS.openai,
        apiKey: "existing-openai-key",
      },
    });
    const repository = createSettingsRepository(storage);

    await repository.save(validDraft, {});

    await expect(repository.load()).resolves.toMatchObject({
      openai: { apiKey: "existing-openai-key" },
    });
  });

  it("clears only the selected provider key idempotently", async () => {
    const storage = createStorage({
      ...DEFAULT_PROVIDER_SETTINGS,
      openai: {
        ...DEFAULT_PROVIDER_SETTINGS.openai,
        apiKey: "existing-openai-key",
      },
      microsoft: {
        ...DEFAULT_PROVIDER_SETTINGS.microsoft,
        apiKey: "existing-microsoft-key",
      },
    });
    const repository = createSettingsRepository(storage);

    await repository.clearApiKey("openai");
    await repository.clearApiKey("openai");

    const stored = await repository.load();
    expect(stored.openai.apiKey).toBeUndefined();
    expect(stored.microsoft.apiKey).toBe("existing-microsoft-key");
  });

  it("falls back safely when stored data has an unknown version or shape", async () => {
    const repository = createSettingsRepository(
      createStorage({ version: 99, provider: "openai", apiKey: "ignored" }),
    );

    await expect(repository.load()).resolves.toEqual(DEFAULT_PROVIDER_SETTINGS);
  });
});
