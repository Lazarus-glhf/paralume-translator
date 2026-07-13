import { createError } from "../shared/errors";
import type {
  ApiKeyReplacements,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../settings/types";
import { validateProviderSettingsDraft } from "../settings/validation";
import { PROTOCOL_VERSION, type ErrorResponse } from "./protocol";
import { parseTranslationResponse, type ValidationResult } from "./validation";

export interface GetSettingsMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "settings";
  command: "get";
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
  | SaveSettingsMessage
  | ClearApiKeyMessage
  | TestConnectionMessage;

export interface SettingsSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  settings: PublicProviderSettings;
  message: string;
}

export type SettingsResponse = SettingsSuccessResponse | ErrorResponse;

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
    !isRecord(value["microsoft"])
  ) {
    return undefined;
  }
  if (
    !hasOnlyKeys(value, ["provider", "openai", "microsoft"]) ||
    !hasOnlyKeys(value["openai"], [
      "baseUrl",
      "model",
      "protocol",
      "reasoningEffort",
    ]) ||
    !hasOnlyKeys(value["microsoft"], ["endpoint", "region"])
  ) {
    return undefined;
  }

  const draft = {
    provider: value["provider"],
    openai: value["openai"],
    microsoft: value["microsoft"],
  } as unknown as ProviderSettingsDraft;
  try {
    const validated = validateProviderSettingsDraft(draft);
    return {
      provider: validated.provider,
      openai: {
        baseUrl: validated.openai.baseUrl,
        model: validated.openai.model,
        protocol: validated.openai.protocol,
        reasoningEffort: validated.openai.reasoningEffort,
      },
      microsoft: {
        endpoint: validated.microsoft.endpoint,
        region: validated.microsoft.region,
      },
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
    value["version"] !== 1 ||
    !isRecord(value["openai"]) ||
    !isRecord(value["microsoft"]) ||
    !hasOnlyKeys(value, ["version", "provider", "openai", "microsoft"]) ||
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
  });
  if (draft === undefined) {
    return undefined;
  }

  return {
    version: 1,
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

export function parseSettingsResponse(
  value: unknown,
): ValidationResult<SettingsResponse> {
  const possibleError = parseTranslationResponse(value);
  if (possibleError.ok && !possibleError.value.ok) {
    return { ok: true, value: possibleError.value };
  }
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "ok", "settings", "message"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["ok"] !== true ||
    typeof value["message"] !== "string" ||
    value["message"].trim() === ""
  ) {
    return invalid();
  }
  const settings = parsePublicSettings(value["settings"]);
  return settings === undefined
    ? invalid()
    : {
        ok: true,
        value: {
          protocolVersion: PROTOCOL_VERSION,
          ok: true,
          settings,
          message: value["message"],
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
