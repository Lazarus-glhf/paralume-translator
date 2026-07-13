export const PROVIDER_SETTINGS_VERSION = 1 as const;

export type ProviderId = "mock" | "openai" | "microsoft";
export type OpenAiProtocol = "responses" | "chat-completions";
export type OpenAiReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high";

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

export interface ProviderSettingsDraft {
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

export interface ProviderSettings {
  version: typeof PROVIDER_SETTINGS_VERSION;
  provider: ProviderId;
  openai: OpenAiSettings;
  microsoft: MicrosoftSettings;
}

export interface PublicProviderSettings {
  version: typeof PROVIDER_SETTINGS_VERSION;
  provider: ProviderId;
  openai: OpenAiSettingsDraft & { apiKeyConfigured: boolean };
  microsoft: MicrosoftSettingsDraft & { apiKeyConfigured: boolean };
}

export interface ApiKeyReplacements {
  openaiApiKey?: string;
  microsoftApiKey?: string;
}
