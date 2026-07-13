import {
  PROVIDER_SETTINGS_VERSION,
  type ApiKeyReplacements,
  type ProviderId,
  type ProviderSettings,
  type ProviderSettingsDraft,
  type PublicProviderSettings,
} from "./types";
import {
  parseStoredProviderSettings,
  validateProviderSettingsDraft,
} from "./validation";

export const SETTINGS_STORAGE_KEY = "providerSettings";

export interface SettingsStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  version: PROVIDER_SETTINGS_VERSION,
  provider: "mock",
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    protocol: "responses",
    reasoningEffort: "low",
  },
  microsoft: {
    endpoint: "https://api.cognitive.microsofttranslator.com",
    region: "global",
  },
};

function cloneDefaults(): ProviderSettings {
  return {
    ...DEFAULT_PROVIDER_SETTINGS,
    openai: { ...DEFAULT_PROVIDER_SETTINGS.openai },
    microsoft: { ...DEFAULT_PROVIDER_SETTINGS.microsoft },
  };
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
  };
}

export function createSettingsRepository(storage: SettingsStorageArea) {
  async function load(): Promise<ProviderSettings> {
    const stored = await storage.get(SETTINGS_STORAGE_KEY);
    return (
      parseStoredProviderSettings(stored[SETTINGS_STORAGE_KEY]) ??
      cloneDefaults()
    );
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

  return { clearApiKey, load, loadPublic, save };
}
