import { createError, messageFromUnknown } from "../shared/errors";
import {
  DEFAULT_PAGE_REQUEST_LIMITS,
  exceedsPageRequestLimits,
  type PageRequestLimits,
} from "../shared/request-budget";
import type { TranslationProvider } from "../translation/provider";
import {
  DEFAULT_BATCH_LIMITS,
  translateInBatches,
  type BatchLimits,
} from "../translation/batcher";
import {
  PROTOCOL_VERSION,
  createErrorResponse,
  type TranslationResponse,
} from "./protocol";
import { parseBackgroundRequest } from "./validation";

export function createBackgroundMessageHandler(
  provider: TranslationProvider,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
  pageRequestLimits: PageRequestLimits = DEFAULT_PAGE_REQUEST_LIMITS,
): (message: unknown) => Promise<TranslationResponse> {
  return async (message) => {
    const parsed = parseBackgroundRequest(message);
    if (!parsed.ok) {
      return createErrorResponse(parsed.error);
    }

    if (
      exceedsPageRequestLimits(parsed.value.request.segments, pageRequestLimits)
    ) {
      return createErrorResponse(
        createError(
          "REQUEST_LIMIT_EXCEEDED",
          `The page request exceeds the limit of ${String(pageRequestLimits.maxSegments)} segments or ${String(pageRequestLimits.maxCharacters)} total characters.`,
        ),
      );
    }

    try {
      const results = await translateInBatches(
        provider,
        parsed.value.request,
        limits,
      );
      return { protocolVersion: PROTOCOL_VERSION, ok: true, results };
    } catch (error) {
      return createErrorResponse(
        createError(
          "INTERNAL_ERROR",
          `The translation request could not be processed: ${messageFromUnknown(error)}`,
          true,
        ),
      );
    }
  };
}
