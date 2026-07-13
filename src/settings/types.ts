import type { UiLanguageSetting } from "../localization";

export const PROVIDER_SETTINGS_VERSION = 2 as const;

export type ProviderId = "mock" | "openai" | "microsoft";
export type OpenAiProtocol = "responses" | "chat-completions";
export type OpenAiReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high";
export type TranslationFontFamily =
  "system" | "sans-serif" | "serif" | "monospace";

export interface OpenAiSettingsDraft {
  baseUrl: string;
  model: string;
  protocol: OpenAiProtocol;
  reasoningEffort: OpenAiReasoningEffort;
}

export interface MicrosoftSettingsDraft {
  endpoint: string;
  region: string;
}

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
}

export interface AppearanceSettings {
  fontFamily: TranslationFontFamily;
  fontSize: number;
  textColor: string;
  backgroundColor: string;
  lineHeight: number;
  opacity: number;
  verticalSpacing: number;
}

export interface ContentSettings {
  retry: RetrySettings;
  appearance: AppearanceSettings;
  uiLanguage: UiLanguageSetting;
}

export interface ProviderSettingsDraft extends ContentSettings {
  provider: ProviderId;
  openai: OpenAiSettingsDraft;
  microsoft: MicrosoftSettingsDraft;
}

export interface OpenAiSettings extends OpenAiSettingsDraft {
  apiKey?: string;
}

export interface MicrosoftSettings extends MicrosoftSettingsDraft {
  apiKey?: string;
}

export interface ProviderSettings extends ContentSettings {
  version: typeof PROVIDER_SETTINGS_VERSION;
  provider: ProviderId;
  openai: OpenAiSettings;
  microsoft: MicrosoftSettings;
}

export interface PublicProviderSettings extends ContentSettings {
  version: typeof PROVIDER_SETTINGS_VERSION;
  provider: ProviderId;
  openai: OpenAiSettingsDraft & { apiKeyConfigured: boolean };
  microsoft: MicrosoftSettingsDraft & { apiKeyConfigured: boolean };
}

export interface ApiKeyReplacements {
  openaiApiKey?: string;
  microsoftApiKey?: string;
}
