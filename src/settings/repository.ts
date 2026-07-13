import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
  cloneDefaultSettings,
} from "./defaults";
import type {
  ApiKeyReplacements,
  ContentSettings,
  ProviderId,
  ProviderSettings,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "./types";
import {
  parseStoredProviderSettings,
  validateProviderSettingsDraft,
} from "./validation";

export {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
};

export const SETTINGS_STORAGE_KEY = "providerSettings";

export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

function toPublicSettings(settings: ProviderSettings): PublicProviderSettings {
  const { apiKey: openaiApiKey, ...openai } = settings.openai;
  const { apiKey: microsoftApiKey, ...microsoft } = settings.microsoft;

  return {
    version: settings.version,
    provider: settings.provider,
    openai: { ...openai, apiKeyConfigured: openaiApiKey !== undefined },
    microsoft: {
      ...microsoft,
      apiKeyConfigured: microsoftApiKey !== undefined,
    },
    retry: { ...settings.retry },
    appearance: { ...settings.appearance },
    uiLanguage: settings.uiLanguage,
  };
}

function toContentSettings(settings: ProviderSettings): ContentSettings {
  return {
    retry: { ...settings.retry },
    appearance: { ...settings.appearance },
    uiLanguage: settings.uiLanguage,
  };
}

export function createSettingsRepository(storage: SettingsStorageArea) {
  async function load(): Promise<ProviderSettings> {
    const stored = await storage.get(SETTINGS_STORAGE_KEY);
    const parsed = parseStoredProviderSettings(stored[SETTINGS_STORAGE_KEY]);
    if (parsed === undefined) {
      return cloneDefaultSettings();
    }
    if (parsed.migrated) {
      await storage.set({ [SETTINGS_STORAGE_KEY]: parsed.settings });
    }
    return parsed.settings;
  }

  async function save(
    draft: ProviderSettingsDraft,
    replacements: ApiKeyReplacements,
  ): Promise<ProviderSettings> {
    const current = await load();
    const validated = validateProviderSettingsDraft(draft);
    const openaiApiKey = replacements.openaiApiKey ?? current.openai.apiKey;
    const microsoftApiKey =
      replacements.microsoftApiKey ?? current.microsoft.apiKey;
    const next: ProviderSettings = {
      ...validated,
      openai:
        openaiApiKey === undefined
          ? validated.openai
          : { ...validated.openai, apiKey: openaiApiKey },
      microsoft:
        microsoftApiKey === undefined
          ? validated.microsoft
          : { ...validated.microsoft, apiKey: microsoftApiKey },
    };

    await storage.set({ [SETTINGS_STORAGE_KEY]: next });
    return next;
  }

  async function loadPublic(): Promise<PublicProviderSettings> {
    return toPublicSettings(await load());
  }

  async function loadContent(): Promise<ContentSettings> {
    return toContentSettings(await load());
  }

  async function clearApiKey(provider: Exclude<ProviderId, "mock">) {
    const current = await load();
    const next: ProviderSettings =
      provider === "openai"
        ? {
            ...current,
            openai: {
              baseUrl: current.openai.baseUrl,
              model: current.openai.model,
              protocol: current.openai.protocol,
              reasoningEffort: current.openai.reasoningEffort,
            },
          }
        : {
            ...current,
            microsoft: {
              endpoint: current.microsoft.endpoint,
              region: current.microsoft.region,
            },
          };

    await storage.set({ [SETTINGS_STORAGE_KEY]: next });
  }

  return { clearApiKey, load, loadContent, loadPublic, save };
}
