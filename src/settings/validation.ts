import type { UiLanguageSetting } from "../localization";
import { UserFacingError } from "../shared/errors";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
} from "./defaults";
import {
  PROVIDER_SETTINGS_VERSION,
  type AppearanceSettings,
  type MicrosoftSettingsDraft,
  type OpenAiProtocol,
  type OpenAiReasoningEffort,
  type OpenAiSettingsDraft,
  type ProviderId,
  type ProviderSettings,
  type ProviderSettingsDraft,
  type RetrySettings,
  type TranslationFontFamily,
} from "./types";

const PROVIDERS: ReadonlySet<ProviderId> = new Set([
  "mock",
  "openai",
  "microsoft",
]);
const OPENAI_PROTOCOLS: ReadonlySet<OpenAiProtocol> = new Set([
  "responses",
  "chat-completions",
]);
const REASONING_EFFORTS: ReadonlySet<OpenAiReasoningEffort> = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
]);
const FONT_FAMILIES: ReadonlySet<TranslationFontFamily> = new Set([
  "system",
  "sans-serif",
  "serif",
  "monospace",
]);
const UI_LANGUAGES: ReadonlySet<UiLanguageSetting> = new Set([
  "system",
  "zh-CN",
  "en",
]);
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/u;

function invalid(): never {
  throw new UserFacingError("VALIDATION_ERROR");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHttpsEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return invalid();
  }

  return url.toString().replace(/\/$/u, "");
}

function requireNonEmpty(value: string): string {
  const normalized = value.trim();
  return normalized === "" ? invalid() : normalized;
}

function clampNumber(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return invalid();
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizeColor(value: unknown): string {
  if (typeof value !== "string" || !HEX_COLOR.test(value)) {
    return invalid();
  }
  const normalized = value.toLowerCase();
  if (normalized.length === 7) {
    return normalized;
  }
  const red = normalized.charAt(1);
  const green = normalized.charAt(2);
  const blue = normalized.charAt(3);
  return `#${red}${red}${green}${green}${blue}${blue}`;
}

export function validateAppearanceSettings(
  value: AppearanceSettings,
): AppearanceSettings {
  if (!FONT_FAMILIES.has(value.fontFamily)) {
    return invalid();
  }
  return {
    fontFamily: value.fontFamily,
    fontSize: clampNumber(value.fontSize, 12, 32),
    textColor: normalizeColor(value.textColor),
    backgroundColor: normalizeColor(value.backgroundColor),
    lineHeight: clampNumber(value.lineHeight, 1, 2.5),
    opacity: clampNumber(value.opacity, 0.4, 1),
    verticalSpacing: clampNumber(value.verticalSpacing, 0, 32),
  };
}

export function validateRetrySettings(value: RetrySettings): RetrySettings {
  if (typeof value.enabled !== "boolean") {
    return invalid();
  }
  const boundedRetries = clampNumber(value.maxRetries, 0, 2);
  return {
    enabled: value.enabled,
    maxRetries: Math.trunc(boundedRetries),
  };
}

function validateUiLanguage(value: UiLanguageSetting): UiLanguageSetting {
  return UI_LANGUAGES.has(value) ? value : invalid();
}

function validateOpenAiSettings(
  value: OpenAiSettingsDraft,
): OpenAiSettingsDraft {
  if (!OPENAI_PROTOCOLS.has(value.protocol)) {
    return invalid();
  }
  if (!REASONING_EFFORTS.has(value.reasoningEffort)) {
    return invalid();
  }
  return {
    baseUrl: normalizeHttpsEndpoint(value.baseUrl),
    model: requireNonEmpty(value.model),
    protocol: value.protocol,
    reasoningEffort: value.reasoningEffort,
  };
}

function validateMicrosoftSettings(
  value: MicrosoftSettingsDraft,
): MicrosoftSettingsDraft {
  return {
    endpoint: normalizeHttpsEndpoint(value.endpoint),
    region: requireNonEmpty(value.region),
  };
}

export function validateProviderSettingsDraft(
  draft: ProviderSettingsDraft,
): ProviderSettings {
  if (!PROVIDERS.has(draft.provider)) {
    return invalid();
  }

  return {
    version: PROVIDER_SETTINGS_VERSION,
    provider: draft.provider,
    openai: validateOpenAiSettings(draft.openai),
    microsoft: validateMicrosoftSettings(draft.microsoft),
    retry: validateRetrySettings(draft.retry),
    appearance: validateAppearanceSettings(draft.appearance),
    uiLanguage: validateUiLanguage(draft.uiLanguage),
  };
}

export function deriveHttpsOriginPattern(endpoint: string): string {
  const normalized = normalizeHttpsEndpoint(endpoint);
  return `${new URL(normalized).origin}/*`;
}

function parseOpenAiSettings(value: unknown): ProviderSettings["openai"] {
  if (
    !isRecord(value) ||
    typeof value["baseUrl"] !== "string" ||
    typeof value["model"] !== "string"
  ) {
    return invalid();
  }
  const validated = validateOpenAiSettings({
    baseUrl: value["baseUrl"],
    model: value["model"],
    protocol: value["protocol"] as OpenAiProtocol,
    reasoningEffort: value["reasoningEffort"] as OpenAiReasoningEffort,
  });
  return typeof value["apiKey"] === "string" && value["apiKey"] !== ""
    ? { ...validated, apiKey: value["apiKey"] }
    : validated;
}

function parseMicrosoftSettings(value: unknown): ProviderSettings["microsoft"] {
  if (
    !isRecord(value) ||
    typeof value["endpoint"] !== "string" ||
    typeof value["region"] !== "string"
  ) {
    return invalid();
  }
  const validated = validateMicrosoftSettings({
    endpoint: value["endpoint"],
    region: value["region"],
  });
  return typeof value["apiKey"] === "string" && value["apiKey"] !== ""
    ? { ...validated, apiKey: value["apiKey"] }
    : validated;
}

export interface ParsedStoredSettings {
  settings: ProviderSettings;
  migrated: boolean;
}

export function parseStoredProviderSettings(
  value: unknown,
): ParsedStoredSettings | undefined {
  if (
    !isRecord(value) ||
    (value["version"] !== 1 &&
      value["version"] !== PROVIDER_SETTINGS_VERSION) ||
    typeof value["provider"] !== "string" ||
    !PROVIDERS.has(value["provider"] as ProviderId)
  ) {
    return undefined;
  }

  try {
    const migrated = value["version"] === 1;
    const settings: ProviderSettings = {
      version: PROVIDER_SETTINGS_VERSION,
      provider: value["provider"] as ProviderId,
      openai: parseOpenAiSettings(value["openai"]),
      microsoft: parseMicrosoftSettings(value["microsoft"]),
      retry: migrated
        ? { ...DEFAULT_RETRY_SETTINGS }
        : validateRetrySettings(value["retry"] as RetrySettings),
      appearance: migrated
        ? { ...DEFAULT_APPEARANCE_SETTINGS }
        : validateAppearanceSettings(value["appearance"] as AppearanceSettings),
      uiLanguage: migrated
        ? "system"
        : validateUiLanguage(value["uiLanguage"] as UiLanguageSetting),
    };
    return { settings, migrated };
  } catch {
    return undefined;
  }
}
