import type { StructuredError } from "../shared/errors";
import type { MessageDescriptor } from "../localization";
import type {
  ContentState,
  TranslationRequest,
  TranslationResult,
} from "../shared/types";

export const PROTOCOL_VERSION = 1 as const;

export type ContentCommand =
  "status" | "translate" | "retry-failed" | "toggle" | "clear";
export type OperationId = string;

export interface BackgroundTranslationMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "background";
  command: "translate";
  operationId: OperationId;
  request: TranslationRequest;
}

export interface BackgroundCancelTranslationMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "background";
  command: "cancel-translation";
  operationId: OperationId;
}

export interface BackgroundTranslationResultMessage {
  protocolVersion: typeof PROTOCOL_VERSION;
  target: "content";
  command: "translation-result";
  operationId: OperationId;
  result: TranslationResult;
}

export type BackgroundMessage =
  BackgroundTranslationMessage | BackgroundCancelTranslationMessage;

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
  message: MessageDescriptor;
}

export interface CancelTranslationSuccessResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: true;
  cancelled: boolean;
}

export interface ErrorResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  ok: false;
  error: StructuredError;
}

export type TranslationResponse = TranslationSuccessResponse | ErrorResponse;
export type CancelTranslationResponse =
  CancelTranslationSuccessResponse | ErrorResponse;
export type BackgroundResponse =
  TranslationResponse | CancelTranslationSuccessResponse;
export type ContentResponse = ContentSuccessResponse | ErrorResponse;

export function createBackgroundTranslationMessage(
  request: TranslationRequest,
  operationId: OperationId,
): BackgroundTranslationMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "background",
    command: "translate",
    operationId,
    request,
  };
}

export function createBackgroundCancelTranslationMessage(
  operationId: OperationId,
): BackgroundCancelTranslationMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "background",
    command: "cancel-translation",
    operationId,
  };
}

export function createBackgroundTranslationResultMessage(
  operationId: OperationId,
  result: TranslationResult,
): BackgroundTranslationResultMessage {
  return {
    protocolVersion: PROTOCOL_VERSION,
    target: "content",
    command: "translation-result",
    operationId,
    result,
  };
}

export function createOperationId(): OperationId {
  return globalThis.crypto.randomUUID();
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
