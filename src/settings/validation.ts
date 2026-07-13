import {
  PROVIDER_SETTINGS_VERSION,
  type MicrosoftSettingsDraft,
  type OpenAiProtocol,
  type OpenAiReasoningEffort,
  type OpenAiSettingsDraft,
  type ProviderId,
  type ProviderSettings,
  type ProviderSettingsDraft,
} from "./types";
import { UserFacingError } from "../shared/errors";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeHttpsEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UserFacingError("VALIDATION_ERROR");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new UserFacingError("VALIDATION_ERROR");
  }

  return url.toString().replace(/\/$/u, "");
}

function requireNonEmpty(value: string): string {
  const normalized = value.trim();
  if (normalized === "") {
    throw new UserFacingError("VALIDATION_ERROR");
  }
  return normalized;
}

export function validateProviderSettingsDraft(
  draft: ProviderSettingsDraft,
): ProviderSettings {
  if (!PROVIDERS.has(draft.provider)) {
    throw new UserFacingError("VALIDATION_ERROR");
  }
  if (!OPENAI_PROTOCOLS.has(draft.openai.protocol)) {
    throw new UserFacingError("VALIDATION_ERROR");
  }
  if (!REASONING_EFFORTS.has(draft.openai.reasoningEffort)) {
    throw new UserFacingError("VALIDATION_ERROR");
  }

  return {
    version: PROVIDER_SETTINGS_VERSION,
    provider: draft.provider,
    openai: {
      baseUrl: normalizeHttpsEndpoint(draft.openai.baseUrl),
      model: requireNonEmpty(draft.openai.model),
      protocol: draft.openai.protocol,
      reasoningEffort: draft.openai.reasoningEffort,
    },
    microsoft: {
      endpoint: normalizeHttpsEndpoint(draft.microsoft.endpoint),
      region: requireNonEmpty(draft.microsoft.region),
    },
  };
}

export function deriveHttpsOriginPattern(endpoint: string): string {
  const normalized = normalizeHttpsEndpoint(endpoint);
  return `${new URL(normalized).origin}/*`;
}

function parseOpenAiSettings(value: unknown): OpenAiSettingsDraft & {
  apiKey?: string;
} {
  if (!isRecord(value)) {
    throw new UserFacingError("VALIDATION_ERROR");
  }
  if (
    typeof value["baseUrl"] !== "string" ||
    typeof value["model"] !== "string"
  ) {
    throw new UserFacingError("VALIDATION_ERROR");
  }

  const draft: OpenAiSettingsDraft = {
    baseUrl: value["baseUrl"],
    model: value["model"],
    protocol: value["protocol"] as OpenAiProtocol,
    reasoningEffort: value["reasoningEffort"] as OpenAiReasoningEffort,
  };
  const validated = validateProviderSettingsDraft({
    provider: "openai",
    openai: draft,
    microsoft: {
      endpoint: "https://api.cognitive.microsofttranslator.com",
      region: "global",
    },
  }).openai;

  return typeof value["apiKey"] === "string" && value["apiKey"] !== ""
    ? { ...validated, apiKey: value["apiKey"] }
    : validated;
}

function parseMicrosoftSettings(value: unknown): MicrosoftSettingsDraft & {
  apiKey?: string;
} {
  if (!isRecord(value)) {
    throw new UserFacingError("VALIDATION_ERROR");
  }
  if (
    typeof value["endpoint"] !== "string" ||
    typeof value["region"] !== "string"
  ) {
    throw new UserFacingError("VALIDATION_ERROR");
  }

  const draft: MicrosoftSettingsDraft = {
    endpoint: value["endpoint"],
    region: value["region"],
  };
  const validated = validateProviderSettingsDraft({
    provider: "microsoft",
    openai: {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5-mini",
      protocol: "responses",
      reasoningEffort: "low",
    },
    microsoft: draft,
  }).microsoft;

  return typeof value["apiKey"] === "string" && value["apiKey"] !== ""
    ? { ...validated, apiKey: value["apiKey"] }
    : validated;
}

export function parseStoredProviderSettings(
  value: unknown,
): ProviderSettings | undefined {
  if (
    !isRecord(value) ||
    value["version"] !== PROVIDER_SETTINGS_VERSION ||
    typeof value["provider"] !== "string" ||
    !PROVIDERS.has(value["provider"] as ProviderId)
  ) {
    return undefined;
  }

  try {
    return {
      version: PROVIDER_SETTINGS_VERSION,
      provider: value["provider"] as ProviderId,
      openai: parseOpenAiSettings(value["openai"]),
      microsoft: parseMicrosoftSettings(value["microsoft"]),
    };
  } catch {
    return undefined;
  }
}
