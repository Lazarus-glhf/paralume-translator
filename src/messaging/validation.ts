import {
  createError,
  isErrorCode,
  SAFE_ERROR_MESSAGES,
  type ErrorCode,
  type StructuredError,
} from "../shared/errors";
import type {
  ContentState,
  SourceSegment,
  TranslationFailure,
  TranslationRequest,
  TranslationResult,
  TranslationSuccess,
} from "../shared/types";
import {
  PROTOCOL_VERSION,
  type BackgroundTranslationMessage,
  type ContentCommand,
  type ContentCommandMessage,
  type ContentResponse,
  type ErrorResponse,
  type TranslationResponse,
} from "./protocol";

export type ValidationResult<T> =
  { ok: true; value: T } | { ok: false; error: StructuredError };

const ERROR_CODES: ReadonlySet<ErrorCode> = new Set(
  Object.keys(SAFE_ERROR_MESSAGES) as ErrorCode[],
);

function invalid(): ValidationResult<never> {
  return {
    ok: false,
    error: createError("INVALID_MESSAGE"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actualKeys = Object.keys(record);
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key) => keys.includes(key))
  );
}

function isNonEmptyString(
  value: unknown,
  maxLength = 100_000,
): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
  );
}

function isSourceSegment(value: unknown): value is SourceSegment {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "text"]) &&
    isNonEmptyString(value["id"], 256) &&
    isNonEmptyString(value["text"])
  );
}

function isTranslationRequest(value: unknown): value is TranslationRequest {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["sourceLanguage", "targetLanguage", "segments"]) ||
    value["sourceLanguage"] !== "auto" ||
    value["targetLanguage"] !== "zh-CN" ||
    !Array.isArray(value["segments"]) ||
    value["segments"].length === 0 ||
    !value["segments"].every(isSourceSegment)
  ) {
    return false;
  }

  const ids = new Set(value["segments"].map((segment) => segment.id));
  return ids.size === value["segments"].length;
}

function isStructuredError(value: unknown): value is StructuredError {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["code", "message", "retryable"]) &&
    isErrorCode(value["code"]) &&
    ERROR_CODES.has(value["code"]) &&
    value["message"] === SAFE_ERROR_MESSAGES[value["code"]] &&
    value["retryable"] === createError(value["code"]).retryable
  );
}

function isTranslationSuccess(value: unknown): value is TranslationSuccess {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "status", "translatedText"]) &&
    isNonEmptyString(value["id"], 256) &&
    value["status"] === "success" &&
    typeof value["translatedText"] === "string"
  );
}

function isTranslationFailure(value: unknown): value is TranslationFailure {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "status", "error"]) &&
    isNonEmptyString(value["id"], 256) &&
    value["status"] === "failure" &&
    isStructuredError(value["error"])
  );
}

function isTranslationResult(value: unknown): value is TranslationResult {
  return isTranslationSuccess(value) || isTranslationFailure(value);
}

function isErrorResponse(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, ["protocolVersion", "ok", "error"]) &&
    value["protocolVersion"] === PROTOCOL_VERSION &&
    value["ok"] === false &&
    isStructuredError(value["error"])
  );
}

function isContentState(value: unknown): value is ContentState {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["translationCount", "failureCount", "visible"]) &&
    Number.isInteger(value["translationCount"]) &&
    Number(value["translationCount"]) >= 0 &&
    Number.isInteger(value["failureCount"]) &&
    Number(value["failureCount"]) >= 0 &&
    typeof value["visible"] === "boolean"
  );
}

export function parseBackgroundRequest(
  value: unknown,
): ValidationResult<BackgroundTranslationMessage> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "target", "command", "request"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["target"] !== "background" ||
    value["command"] !== "translate" ||
    !isTranslationRequest(value["request"])
  ) {
    return invalid();
  }

  return { ok: true, value: value as unknown as BackgroundTranslationMessage };
}

export function parseContentCommand(
  value: unknown,
): ValidationResult<ContentCommandMessage> {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["protocolVersion", "target", "command"]) ||
    value["protocolVersion"] !== PROTOCOL_VERSION ||
    value["target"] !== "content" ||
    !(["translate", "toggle", "clear"] as const).includes(
      value["command"] as ContentCommand,
    )
  ) {
    return invalid();
  }

  return { ok: true, value: value as unknown as ContentCommandMessage };
}

export function parseTranslationResponse(
  value: unknown,
): ValidationResult<TranslationResponse> {
  if (!isRecord(value)) {
    return invalid();
  }

  if (isErrorResponse(value)) {
    return { ok: true, value: value as unknown as ErrorResponse };
  }

  if (
    hasOnlyKeys(value, ["protocolVersion", "ok", "results"]) &&
    value["protocolVersion"] === PROTOCOL_VERSION &&
    value["ok"] === true &&
    Array.isArray(value["results"]) &&
    value["results"].every(isTranslationResult)
  ) {
    return { ok: true, value: value as unknown as TranslationResponse };
  }

  return invalid();
}

export function parseContentResponse(
  value: unknown,
): ValidationResult<ContentResponse> {
  if (!isRecord(value)) {
    return invalid();
  }

  if (isErrorResponse(value)) {
    return { ok: true, value: value as unknown as ErrorResponse };
  }

  if (
    hasOnlyKeys(value, ["protocolVersion", "ok", "state", "message"]) &&
    value["protocolVersion"] === PROTOCOL_VERSION &&
    value["ok"] === true &&
    isContentState(value["state"]) &&
    isNonEmptyString(value["message"], 2_000)
  ) {
    return { ok: true, value: value as unknown as ContentResponse };
  }

  return invalid();
}
