export type ErrorCode =
  | "INVALID_MESSAGE"
  | "NO_ACTIVE_TAB"
  | "RESTRICTED_PAGE"
  | "INJECTION_FAILED"
  | "TRANSLATION_FAILED"
  | "REQUEST_LIMIT_EXCEEDED"
  | "SEGMENT_TOO_LARGE"
  | "MISSING_RESULT"
  | "DUPLICATE_RESULT"
  | "INTERNAL_ERROR";

export interface StructuredError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export function createError(
  code: ErrorCode,
  message: string,
  retryable = false,
): StructuredError {
  return { code, message, retryable };
}

export function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}
