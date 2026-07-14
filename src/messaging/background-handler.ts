import { throwIfAborted } from "../shared/abort";
import { createError, sanitizeError } from "../shared/errors";
import {
  DEFAULT_PAGE_REQUEST_LIMITS,
  exceedsPageRequestLimits,
  type PageRequestLimits,
} from "../shared/request-budget";
import type { TranslationRequest, TranslationResult } from "../shared/types";
import type {
  TranslationProvider,
  TranslationProviderResolver,
} from "../translation/provider";
import {
  DEFAULT_BATCH_LIMITS,
  translateInBatches,
  type BatchLimits,
} from "../translation/batcher";
import {
  PROTOCOL_VERSION,
  createErrorResponse,
  type BackgroundResponse,
  type TranslationResponse,
} from "./protocol";
import { parseBackgroundMessage } from "./validation";

export interface BackgroundMessageContext<Sender = unknown> {
  readonly sender: Sender;
}

export interface BackgroundHandlerDependencies<Sender = unknown> {
  readonly sendResult?: (
    sender: Sender,
    operationId: string,
    result: TranslationResult,
  ) => void;
}

interface ActiveOperation {
  readonly controller: AbortController;
  readonly promise: Promise<TranslationResponse>;
  readonly request: TranslationRequest;
}

const MAX_PENDING_CANCELLATIONS_PER_SENDER = 256;
const MAX_PENDING_CANCELLATION_SENDERS = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function senderScope(sender: unknown): string {
  if (!isRecord(sender)) {
    return "direct";
  }

  const tab = sender["tab"];
  const tabId =
    isRecord(tab) && Number.isInteger(tab["id"]) ? Number(tab["id"]) : null;
  const frameId = Number.isInteger(sender["frameId"])
    ? Number(sender["frameId"])
    : null;
  const documentId =
    typeof sender["documentId"] === "string" ? sender["documentId"] : null;
  const extensionId = typeof sender["id"] === "string" ? sender["id"] : null;

  return JSON.stringify([tabId, frameId, documentId, extensionId]);
}

function sameRequest(
  first: TranslationRequest,
  second: TranslationRequest,
): boolean {
  return (
    first.segments.length === second.segments.length &&
    first.segments.every((segment, index) => {
      const candidate = second.segments[index];
      return candidate?.id === segment.id && candidate.text === segment.text;
    })
  );
}

function cancelledResponse(): TranslationResponse {
  return createErrorResponse(createError("TRANSLATION_CANCELLED"));
}

export function createBackgroundMessageHandler<Sender = unknown>(
  provider: TranslationProvider | TranslationProviderResolver,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
  pageRequestLimits: PageRequestLimits = DEFAULT_PAGE_REQUEST_LIMITS,
  dependencies: BackgroundHandlerDependencies<Sender> = {},
): (
  message: unknown,
  context?: BackgroundMessageContext<Sender>,
) => Promise<BackgroundResponse> {
  const activeOperations = new Map<string, Map<string, ActiveOperation>>();
  const pendingCancellations = new Map<string, Map<string, true>>();

  const rememberPendingCancellation = (
    operationId: string,
    scope: string,
  ): void => {
    let scopedCancellations = pendingCancellations.get(scope);
    if (scopedCancellations === undefined) {
      // Keep total retained state bounded without allowing a new sender scope
      // to evict pending cancellation state owned by an existing sender.
      if (pendingCancellations.size >= MAX_PENDING_CANCELLATION_SENDERS) {
        return;
      }
      scopedCancellations = new Map();
      pendingCancellations.set(scope, scopedCancellations);
    }
    if (scopedCancellations.has(operationId)) {
      return;
    }
    if (scopedCancellations.size >= MAX_PENDING_CANCELLATIONS_PER_SENDER) {
      const oldest: string | undefined = scopedCancellations
        .keys()
        .next().value;
      if (oldest !== undefined) {
        scopedCancellations.delete(oldest);
      }
    }
    scopedCancellations.set(operationId, true);
  };

  const consumePendingCancellation = (
    operationId: string,
    scope: string,
  ): boolean => {
    const scopedCancellations = pendingCancellations.get(scope);
    if (scopedCancellations?.delete(operationId) !== true) {
      return false;
    }
    if (scopedCancellations.size === 0) {
      pendingCancellations.delete(scope);
    }
    return true;
  };

  return (message, context) => {
    const sender = context?.sender;
    const parsed = parseBackgroundMessage(message);
    if (!parsed.ok) {
      return Promise.resolve(createErrorResponse(parsed.error));
    }

    const scope = senderScope(sender);
    if (parsed.value.command === "cancel-translation") {
      const active = activeOperations.get(scope)?.get(parsed.value.operationId);
      if (active === undefined) {
        rememberPendingCancellation(parsed.value.operationId, scope);
        return Promise.resolve({
          protocolVersion: PROTOCOL_VERSION,
          ok: true,
          cancelled: false,
        });
      }
      active.controller.abort();
      return Promise.resolve({
        protocolVersion: PROTOCOL_VERSION,
        ok: true,
        cancelled: true,
      });
    }

    const translationMessage = parsed.value;
    if (consumePendingCancellation(translationMessage.operationId, scope)) {
      return Promise.resolve(cancelledResponse());
    }

    if (
      exceedsPageRequestLimits(
        translationMessage.request.segments,
        pageRequestLimits,
      )
    ) {
      return Promise.resolve(
        createErrorResponse(createError("REQUEST_LIMIT_EXCEEDED")),
      );
    }

    let scopedActiveOperations = activeOperations.get(scope);
    const existing = scopedActiveOperations?.get(
      translationMessage.operationId,
    );
    if (existing !== undefined) {
      if (sameRequest(existing.request, translationMessage.request)) {
        return existing.promise;
      }
      return Promise.resolve(
        createErrorResponse(createError("INVALID_MESSAGE")),
      );
    }

    const controller = new AbortController();
    const run = async (): Promise<TranslationResponse> => {
      let selectedProvider: TranslationProvider;
      try {
        selectedProvider =
          typeof provider === "function" ? await provider() : provider;
        throwIfAborted(controller.signal);
      } catch (error) {
        return controller.signal.aborted
          ? cancelledResponse()
          : createErrorResponse(sanitizeError(error, "TRANSLATION_FAILED"));
      }

      try {
        const results = await translateInBatches(
          selectedProvider,
          translationMessage.request,
          limits,
          controller.signal,
          dependencies.sendResult === undefined
            ? undefined
            : (result) => {
                if (!controller.signal.aborted) {
                  if (sender !== undefined) {
                    dependencies.sendResult?.(
                      sender,
                      translationMessage.operationId,
                      result,
                    );
                  }
                }
              },
        );
        return { protocolVersion: PROTOCOL_VERSION, ok: true, results };
      } catch (error) {
        return controller.signal.aborted
          ? cancelledResponse()
          : createErrorResponse(sanitizeError(error, "INTERNAL_ERROR"));
      }
    };

    const promise = run().finally(() => {
      if (
        scopedActiveOperations?.get(translationMessage.operationId)
          ?.controller === controller
      ) {
        scopedActiveOperations.delete(translationMessage.operationId);
        if (scopedActiveOperations.size === 0) {
          activeOperations.delete(scope);
        }
      }
    });
    const active: ActiveOperation = {
      controller,
      promise,
      request: translationMessage.request,
    };
    if (scopedActiveOperations === undefined) {
      scopedActiveOperations = new Map();
      activeOperations.set(scope, scopedActiveOperations);
    }
    scopedActiveOperations.set(translationMessage.operationId, active);
    return promise;
  };
}
