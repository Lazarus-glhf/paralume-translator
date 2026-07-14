import {
  PROVIDER_SETTINGS_VERSION,
  type AppearanceSettings,
  type ProviderSettings,
  type RetrySettings,
} from "./types";

export const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 2,
};

export const DEFAULT_APPEARANCE_SETTINGS: AppearanceSettings = {
  fontFamily: "system",
  fontSize: 16,
  textColor: "#52525b",
  backgroundColor: "#fafafa",
  lineHeight: 1.68,
  opacity: 1,
  verticalSpacing: 6,
};

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  version: PROVIDER_SETTINGS_VERSION,
  provider: "openai",
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
  retry: DEFAULT_RETRY_SETTINGS,
  appearance: DEFAULT_APPEARANCE_SETTINGS,
  uiLanguage: "system",
};

export function cloneDefaultSettings(): ProviderSettings {
  return {
    ...DEFAULT_PROVIDER_SETTINGS,
    openai: { ...DEFAULT_PROVIDER_SETTINGS.openai },
    microsoft: { ...DEFAULT_PROVIDER_SETTINGS.microsoft },
    retry: { ...DEFAULT_RETRY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
  };
}
