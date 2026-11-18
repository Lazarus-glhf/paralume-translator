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

export interface SaveSettingsResult {
  readonly settings: ProviderSettings;
  // Providers whose stored key was dropped because the endpoint origin
  // changed and no replacement key was supplied.
  readonly removedApiKeys: readonly Exclude<ProviderId, "mock">[];
}

export interface StorageAccessLevelArea {
  setAccessLevel?: (options: {
    accessLevel: "TRUSTED_CONTEXTS";
  }) => Promise<void>;
}

// storage.local defaults to also being readable by content scripts. Limit it
// to extension pages and the service worker so page-injected code has no
// storage path to API keys. Returns false when the browser does not support
// or rejects the restriction; callers must not depend on it for correctness.
export async function restrictStorageToTrustedContexts(
  area: StorageAccessLevelArea,
): Promise<boolean> {
  if (typeof area.setAccessLevel !== "function") {
    return false;
  }
  try {
    await area.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    return true;
  } catch {
    return false;
  }
}

function sameOrigin(previous: string, next: string): boolean {
  try {
    return new URL(previous).origin === new URL(next).origin;
  } catch {
    return false;
  }
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
  ): Promise<SaveSettingsResult> {
    const current = await load();
    const validated = validateProviderSettingsDraft(draft);
    // A saved key is bound to the origin it was entered for. Moving the
    // endpoint to another origin without a new key must not forward the old
    // key there, so the old key is dropped and the user enters it again.
    const keepOpenAiKey = sameOrigin(
      current.openai.baseUrl,
      validated.openai.baseUrl,
    );
    const keepMicrosoftKey = sameOrigin(
      current.microsoft.endpoint,
      validated.microsoft.endpoint,
    );
    const openaiApiKey =
      replacements.openaiApiKey ??
      (keepOpenAiKey ? current.openai.apiKey : undefined);
    const microsoftApiKey =
      replacements.microsoftApiKey ??
      (keepMicrosoftKey ? current.microsoft.apiKey : undefined);
    const removedApiKeys: Exclude<ProviderId, "mock">[] = [];
    if (current.openai.apiKey !== undefined && openaiApiKey === undefined) {
      removedApiKeys.push("openai");
    }
    if (
      current.microsoft.apiKey !== undefined &&
      microsoftApiKey === undefined
    ) {
      removedApiKeys.push("microsoft");
    }
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
    return { settings: next, removedApiKeys };
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
