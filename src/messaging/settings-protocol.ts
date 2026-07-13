import {
  isMessageId,
  type MessageDescriptor,
  type MessageValue,
} from "../localization";
import { createError } from "../shared/errors";
import {
  PROVIDER_SETTINGS_VERSION,
  type ApiKeyReplacements,
  type ContentSettings,
  type ProviderSettingsDraft,
  type PublicProviderSettings,
} from "../settings/types";
import { validateProviderSettingsDraft } from "../settings/validation";
import { PROTOCOL_VERSION, type ErrorResponse } from "./protocol";
import { parseTranslationResponse, type ValidationResult } from "./validation";

export interface GetSettingsMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "get";
}

export interface GetContentSettingsMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "get-content";
}

export interface SaveSettingsMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "save";
  draft: ProviderSettingsDraft;
  apiKeys: ApiKeyReplacements;
}

export interface ClearApiKeyMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "clear-api-key";
  provider: "openai" | "microsoft";
}

export interface TestConnectionMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "test-connection";
}

export type SettingsRequest =
  | GetSettingsMessage
  | GetContentSettingsMessage
  | SaveSettingsMessage
  | ClearApiKeyMessage
  | TestConnectionMessage;

export interface SettingsSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  settings: PublicProviderSettings;
  message: MessageDescriptor;
}

export interface ContentSettingsSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  contentSettings: ContentSettings;
}

export type SettingsResponse = SettingsSuccessResponse | ErrorResponse;
export type ContentSettingsResponse =
  ContentSettingsSuccessResponse | ErrorResponse;
export type AnySettingsResponse = SettingsResponse | ContentSettingsResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length && actual.every((key) => keys.includes(key))
  );
}

function invalid(): ValidationResult<never> {
  return { ok: false, error: createError("INVALID_MESSAGE") };
}

function parseDraft(value: unknown): ProviderSettingsDraft | undefined {
  if (
    !isRecord(value) ||
    !isRecord(value["openai"]) ||
    !isRecord(value["microsoft"]) ||
    !isRecord(value["retry"]) ||
    !isRecord(value["appearance"]) ||
    !hasOnlyKeys(value, [
      "provider",
      "openai",
      "microsoft",
      "retry",
      "appearance",
      "uiLanguage",
    ]) ||
    !hasOnlyKeys(value["openai"], [
      "baseUrl",
      "model",
      "protocol",
      "reasoningEffort",
    ]) ||
    !hasOnlyKeys(value["microsoft"], ["endpoint", "region"]) ||
    !hasOnlyKeys(value["retry"], ["enabled", "maxRetries"]) ||
    !hasOnlyKeys(value["appearance"], [
      "fontFamily",
      "fontSize",
      "textColor",
      "backgroundColor",
      "lineHeight",
      "opacity",
      "verticalSpacing",
    ])
  ) {
    return undefined;
  }

  try {
    const validated = validateProviderSettingsDraft(
      value as unknown as ProviderSettingsDraft,
    );
    return {
      provider: validated.provider,
      openai: { ...validated.openai },
      microsoft: { ...validated.microsoft },
      retry: { ...validated.retry },
      appearance: { ...validated.appearance },
      uiLanguage: validated.uiLanguage,
    };
  } catch {
    return undefined;
  }
}

function parseApiKeys(value: unknown): ApiKeyReplacements | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const allowed = ["openaiApiKey", "microsoftApiKey"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    return undefined;
  }
  for (const key of allowed) {
    const candidate = value[key];
    if (
      candidate !== undefined &&
      (typeof candidate !== "string" ||
        candidate.length === 0 ||
        candidate.length > 10_000)
    ) {
      return undefined;
    }
  }

  return {
    ...(typeof value["openaiApiKey"] === "string"
      ? { openaiApiKey: value["openaiApiKey"] }
      : {}),
    ...(typeof value["microsoftApiKey"] === "string"
      ? { microsoftApiKey: value["microsoftApiKey"] }
      : {}),
  };
}

function parsePublicSettings(
  value: unknown,
): PublicProviderSettings | undefined {
  if (
    !isRecord(value) ||
    value["version"] !== PROVIDER_SETTINGS_VERSION ||
    !isRecord(value["openai"]) ||
    !isRecord(value["microsoft"]) ||
    !hasOnlyKeys(value, [
      "version",
      "provider",
      "openai",
      "microsoft",
      "retry",
      "appearance",
      "uiLanguage",
    ]) ||
    !hasOnlyKeys(value["openai"], [
      "baseUrl",
      "model",
      "protocol",
      "reasoningEffort",
      "apiKeyConfigured",
    ]) ||
    !hasOnlyKeys(value["microsoft"], [
      "endpoint",
      "region",
      "apiKeyConfigured",
    ]) ||
    typeof value["openai"]["apiKeyConfigured"] !== "boolean" ||
    typeof value["microsoft"]["apiKeyConfigured"] !== "boolean"
  ) {
    return undefined;
  }

  const draft = parseDraft({
    provider: value["provider"],
    openai: {
      baseUrl: value["openai"]["baseUrl"],
      model: value["openai"]["model"],
      protocol: value["openai"]["protocol"],
      reasoningEffort: value["openai"]["reasoningEffort"],
    },
    microsoft: {
      endpoint: value["microsoft"]["endpoint"],
      region: value["microsoft"]["region"],
    },
    retry: value["retry"],
    appearance: value["appearance"],
    uiLanguage: value["uiLanguage"],
  });
  if (draft === undefined) {
    return undefined;
  }

  return {
    version: PROVIDER_SETTINGS_VERSION,
    ...draft,
    openai: {
      ...draft.openai,
      apiKeyConfigured: value["openai"]["apiKeyConfigured"],
    },
    microsoft: {
      ...draft.microsoft,
      apiKeyConfigured: value["microsoft"]["apiKeyConfigured"],
    },
  };
}

function parseContentSettings(value: unknown): ContentSettings | undefined {
  const defaults = {
    provider: "mock" as const,
    openai: {
      baseUrl: "https://api.openai.com/v1",
      model: "unused",
      protocol: "responses" as const,
      reasoningEffort: "low" as const,
    },
    microsoft: {
      endpoint: "https://api.cognitive.microsofttranslator.com",
      region: "unused",
    },
  };
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["retry", "appearance", "uiLanguage"])
  ) {
    return undefined;
  }
  const parsed = parseDraft({ ...defaults, ...value });
  return parsed === undefined
    ? undefined
    : {
        retry: parsed.retry,
        appearance: parsed.appearance,
        uiLanguage: parsed.uiLanguage,
      };
}

function parseMessageValues(
  value: unknown,
): Readonly<Record<string, MessageValue>> | undefined {
  if (!isRecord(value) || Object.keys(value).length > 20) {
    return undefined;
  }
  for (const candidate of Object.values(value)) {
    if (
      (typeof candidate !== "string" && typeof candidate !== "number") ||
      (typeof candidate === "string" && candidate.length > 2_000) ||
      (typeof candidate === "number" && !Number.isFinite(candidate))
    ) {
      return undefined;
    }
  }
  return value as Readonly<Record<string, MessageValue>>;
}

function parseMessageDescriptor(value: unknown): MessageDescriptor | undefined {
  if (!isRecord(value) || !isMessageId(value["id"])) {
    return undefined;
  }
  if (hasOnlyKeys(value, ["id"])) {
    return { id: value["id"] };
  }
  if (!hasOnlyKeys(value, ["id", "values"])) {
    return undefined;
  }
  const values = parseMessageValues(value["values"]);
  return values === undefined ? undefined : { id: value["id"], values };
}

export function parseSettingsRequest(
  value: unknown,
): ValidationResult<SettingsRequest> {
  if (
    !isRecord(value) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["target"] !== "settings"
  ) {
    return invalid();
  }

  switch (value["command"]) {
    case "get":
    case "get-content":
    case "test-connection":
      return hasOnlyKeys(value, ["protocolVersion", "target", "command"])
        ? { ok: true, value: value as unknown as SettingsRequest }
        : invalid();
    case "clear-api-key":
      return hasOnlyKeys(value, [
        "protocolVersion",
        "target",
        "command",
        "provider",
      ]) &&
        (value["provider"] === "openai" || value["provider"] === "microsoft")
        ? { ok: true, value: value as unknown as ClearApiKeyMessage }
        : invalid();
    case "save": {
      const draft = parseDraft(value["draft"]);
      const apiKeys = parseApiKeys(value["apiKeys"]);
      return hasOnlyKeys(value, [
        "protocolVersion",
        "target",
        "command",
        "draft",
        "apiKeys",
      ]) &&
        draft !== undefined &&
        apiKeys !== undefined
        ? {
            ok: true,
            value: {
              protocolVersion: PROTOCOL_VERSION,
              target: "settings",
              command: "save",
              draft,
              apiKeys,
            },
          }
        : invalid();
    }
    default:
      return invalid();
  }
}

function parseErrorResponse(value: unknown): ErrorResponse | undefined {
  const possibleError = parseTranslationResponse(value);
  return possibleError.ok && !possibleError.value.ok
    ? possibleError.value
    : undefined;
}

export function parseSettingsResponse(
  value: unknown,
): ValidationResult<SettingsResponse> {
  const error = parseErrorResponse(value);
  if (error !== undefined) {
    return { ok: true, value: error };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "ok", "settings", "message"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["ok"] !== true
  ) {
    return invalid();
  }
  const settings = parsePublicSettings(value["settings"]);
  const message = parseMessageDescriptor(value["message"]);
  return settings === undefined || message === undefined
    ? invalid()
    : {
        ok: true,
        value: {
          protocolVersion: PROTOCOL_VERSION,
          ok: true,
          settings,
          message,
        },
      };
}

export function parseContentSettingsResponse(
  value: unknown,
): ValidationResult<ContentSettingsResponse> {
  const error = parseErrorResponse(value);
  if (error !== undefined) {
    return { ok: true, value: error };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "ok", "contentSettings"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["ok"] !== true
  ) {
    return invalid();
  }
  const contentSettings = parseContentSettings(value["contentSettings"]);
  return contentSettings === undefined
    ? invalid()
    : {
        ok: true,
        value: {
          protocolVersion: PROTOCOL_VERSION,
          ok: true,
          contentSettings,
        },
      };
}

export function createGetSettingsMessage(): GetSettingsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "get",
  };
}

export function createGetContentSettingsMessage(): GetContentSettingsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "get-content",
  };
}

export function createSaveSettingsMessage(
  draft: ProviderSettingsDraft,
  apiKeys: ApiKeyReplacements,
): SaveSettingsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "save",
    draft,
    apiKeys,
  };
}

export function createClearApiKeyMessage(
  provider: "openai" | "microsoft",
): ClearApiKeyMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "clear-api-key",
    provider,
  };
}

export function createTestConnectionMessage(): TestConnectionMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "test-connection",
  };
}
