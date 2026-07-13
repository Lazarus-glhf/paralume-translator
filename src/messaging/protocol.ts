import type { StructuredError } from "../shared/errors";
import type {
  ContentState,
  TranslationRequest,
  TranslationResult,
} from "../shared/types";

export const PROTOCOL_VERSION = 1 as const;

export type ContentCommand = "translate" | "toggle" | "clear";

export interface BackgroundTranslationMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "background";
  command: "translate";
  request: TranslationRequest;
}

export interface ContentCommandMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "content";
  command: ContentCommand;
}

export interface TranslationSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  results: readonly TranslationResult[];
}

export interface ContentSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  state: ContentState;
  message: string;
}

export interface ErrorResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: false;
  error: StructuredError;
}

export type TranslationResponse = TranslationSuccessResponse | ErrorResponse;
export type ContentResponse = ContentSuccessResponse | ErrorResponse;

export function createBackgroundTranslationMessage(
  request: TranslationRequest,
): BackgroundTranslationMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "background",
    command: "translate",
    request,
  };
}

export function createContentCommand(
  command: ContentCommand,
): ContentCommandMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "content",
    command,
  };
}

export function createErrorResponse(error: StructuredError): ErrorResponse {
  return { protocolVersion: PROTOCOL_VERSION, ok: false, error };
}
