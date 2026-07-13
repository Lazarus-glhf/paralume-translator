export const SAFE_ERROR_MESSAGES = {
  INVALID_MESSAGE: "The request or response was malformed.",
  NO_ACTIVE_TAB: "Paralume could not access an active browser tab.",
  RESTRICTED_PAGE:
    "Paralume cannot run on browser-internal, extension, or other restricted pages. Open a regular webpage and try again.",
  INJECTION_FAILED:
    "Paralume could not access this page. Reload it and try again.",
  TRANSLATION_FAILED:
    "The translation request failed. Check the provider settings and try again.",
  REQUEST_LIMIT_EXCEEDED:
    "The page contains too much text for one translation request.",
  SEGMENT_TOO_LARGE:
    "A readable block exceeds the translation batch character limit.",
  MISSING_RESULT:
    "The provider did not return a result for a requested segment.",
  DUPLICATE_RESULT:
    "The provider returned duplicate results for a requested segment.",
  INTERNAL_ERROR: "Paralume could not complete the request.",
  AUTHENTICATION_FAILED: "The provider rejected the configured credentials.",
  RATE_LIMITED: "The provider rate limit was reached. Try again later.",
  REQUEST_TIMEOUT: "The provider request timed out. Try again.",
  NETWORK_ERROR:
    "The provider could not be reached. Check the network and endpoint settings.",
  SERVER_UNAVAILABLE:
    "The provider is temporarily unavailable. Try again later.",
  MALFORMED_JSON: "The provider returned malformed JSON.",
  MALFORMED_PROVIDER_OUTPUT:
    "The provider returned output that does not match the required format.",
  API_KEY_UNCONFIGURED: "The selected provider API key is not configured.",
  PERMISSION_MISSING:
    "Access to the configured provider origin is not granted. Save the provider settings again.",
  VALIDATION_ERROR:
    "The provider settings are invalid. Review the fields and try again.",
} as const;

export type ErrorCode = keyof typeof SAFE_ERROR_MESSAGES;

const RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "NO_ACTIVE_TAB",
  "INJECTION_FAILED",
  "TRANSLATION_FAILED",
  "MISSING_RESULT",
  "INTERNAL_ERROR",
  "RATE_LIMITED",
  "REQUEST_TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_UNAVAILABLE",
]);

export interface StructuredError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export class UserFacingError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode) {
    super(SAFE_ERROR_MESSAGES[code]);
    this.name = "UserFacingError";
    this.code = code;
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(SAFE_ERROR_MESSAGES, value);
}

export function createError(code: ErrorCode): StructuredError {
  return {
    code,
    message: SAFE_ERROR_MESSAGES[code],
    retryable: RETRYABLE_ERROR_CODES.has(code),
  };
}

export function sanitizeError(
  error: unknown,
  fallback: ErrorCode = "INTERNAL_ERROR",
): StructuredError {
  return error instanceof UserFacingError
    ? createError(error.code)
    : createError(fallback);
}

export function sanitizeStructuredError(
  error: unknown,
  fallback: ErrorCode = "TRANSLATION_FAILED",
): StructuredError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    isErrorCode(error.code)
  ) {
    return createError(error.code);
  }
  return createError(fallback);
}

export function safeMessageFromUnknown(
  error: unknown,
  fallback: ErrorCode = "INTERNAL_ERROR",
): string {
  return sanitizeError(error, fallback).message;
}
