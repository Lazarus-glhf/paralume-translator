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
import { isValidSiteKey } from "../settings/site-preferences";
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

export interface OpenOptionsMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "open-options";
}

// Floating-menu site preference for the sender's own site. The site is
// derived from the sender URL in the background, never from the message.
export interface GetSiteStateMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "get-site-state";
}

export interface DisableSiteMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "disable-site";
}

export interface ListDisabledSitesMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "list-disabled-sites";
}

export interface EnableSiteMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "enable-site";
  site: string;
}

export type SettingsRequest =
  | GetSettingsMessage
  | GetContentSettingsMessage
  | SaveSettingsMessage
  | ClearApiKeyMessage
  | TestConnectionMessage
  | OpenOptionsMessage
  | GetSiteStateMessage
  | DisableSiteMessage
  | ListDisabledSitesMessage
  | EnableSiteMessage;

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
export interface OpenOptionsSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
}

export interface SiteStateSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  siteDisabled: boolean;
}

export interface DisabledSitesSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  sites: readonly string[];
}

export type SiteStateResponse = SiteStateSuccessResponse | ErrorResponse;
export type DisableSiteResponse = OpenOptionsSuccessResponse | ErrorResponse;
export type DisabledSitesResponse =
  DisabledSitesSuccessResponse | ErrorResponse;
export type EnableSiteResponse = OpenOptionsSuccessResponse | ErrorResponse;

export type AnySettingsResponse =
  | SettingsResponse
  | ContentSettingsResponse
  | OpenOptionsSuccessResponse
  | SiteStateSuccessResponse
  | DisabledSitesSuccessResponse;

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
    case "open-options":
    case "get-site-state":
    case "disable-site":
    case "list-disabled-sites":
      return hasOnlyKeys(value, ["protocolVersion", "target", "command"])
        ? { ok: true, value: value as unknown as SettingsRequest }
        : invalid();
    case "enable-site":
      return hasOnlyKeys(value, [
        "protocolVersion",
        "target",
        "command",
        "site",
      ]) && isValidSiteKey(value["site"])
        ? { ok: true, value: value as unknown as EnableSiteMessage }
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

export function parseSiteStateResponse(
  value: unknown,
): ValidationResult<SiteStateResponse> {
  const error = parseErrorResponse(value);
  if (error !== undefined) {
    return { ok: true, value: error };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "ok", "siteDisabled"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["ok"] !== true ||
    typeof value["siteDisabled"] !== "boolean"
  ) {
    return invalid();
  }
  return {
    ok: true,
    value: {
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      siteDisabled: value["siteDisabled"],
    },
  };
}

export function parseDisableSiteResponse(
  value: unknown,
): ValidationResult<DisableSiteResponse> {
  const error = parseErrorResponse(value);
  if (error !== undefined) {
    return { ok: true, value: error };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "ok"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["ok"] !== true
  ) {
    return invalid();
  }
  return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, ok: true } };
}

export function parseDisabledSitesResponse(
  value: unknown,
): ValidationResult<DisabledSitesResponse> {
  const error = parseErrorResponse(value);
  if (error !== undefined) {
    return { ok: true, value: error };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "ok", "sites"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["ok"] !== true ||
    !Array.isArray(value["sites"]) ||
    value["sites"].length > 10_000 ||
    !value["sites"].every(isValidSiteKey) ||
    new Set(value["sites"]).size !== value["sites"].length
  ) {
    return invalid();
  }
  return {
    ok: true,
    value: {
      protocolVersion: PROTOCOL_VERSION,
      ok: true,
      sites: value["sites"],
    },
  };
}

export const parseEnableSiteResponse = parseDisableSiteResponse;

export function createGetSiteStateMessage(): GetSiteStateMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "get-site-state",
  };
}

export function createDisableSiteMessage(): DisableSiteMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "disable-site",
  };
}

export function createListDisabledSitesMessage(): ListDisabledSitesMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "list-disabled-sites",
  };
}

export function createEnableSiteMessage(site: string): EnableSiteMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "enable-site",
    site,
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

export function createOpenOptionsMessage(): OpenOptionsMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "settings",
    command: "open-options",
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
