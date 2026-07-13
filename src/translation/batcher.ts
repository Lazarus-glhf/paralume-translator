import { createError, messageFromUnknown } from "../shared/errors";
import type {
  SourceSegment,
  TranslationFailure,
  TranslationRequest,
  TranslationResult,
} from "../shared/types";
import type { TranslationProvider } from "./provider";

export interface BatchLimits {
  maxSegments: number;
  maxCharacters: number;
  concurrency: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxSegments: 20,
  maxCharacters: 6_000,
  concurrency: 3,
};

function assertLimits(limits: BatchLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

function failure(
  segment: SourceSegment,
  code:
    | "SEGMENT_TOO_LARGE"
    | "MISSING_RESULT"
    | "DUPLICATE_RESULT"
    | "TRANSLATION_FAILED",
  message: string,
  retryable = false,
): TranslationFailure {
  return {
    id: segment.id,
    status: "failure",
    error: createError(code, message, retryable),
  };
}

function createBatches(
  segments: readonly SourceSegment[],
  limits: BatchLimits,
): {
  batches: SourceSegment[][];
  immediateResults: Map<string, TranslationResult>;
} {
  const batches: SourceSegment[][] = [];
  const immediateResults = new Map<string, TranslationResult>();
  let current: SourceSegment[] = [];
  let currentCharacters = 0;

  const flush = () => {
    if (current.length > 0) {
      batches.push(current);
      current = [];
      currentCharacters = 0;
    }
  };

  for (const segment of segments) {
    if (segment.text.length > limits.maxCharacters) {
      flush();
      immediateResults.set(
        segment.id,
        failure(
          segment,
          "SEGMENT_TOO_LARGE",
          `Segment ${segment.id} exceeds the ${String(limits.maxCharacters)}-character batch limit.`,
        ),
      );
      continue;
    }

    if (
      current.length >= limits.maxSegments ||
      currentCharacters + segment.text.length > limits.maxCharacters
    ) {
      flush();
    }

    current.push(segment);
    currentCharacters += segment.text.length;
  }

  flush();
  return { batches, immediateResults };
}

async function translateBatch(
  provider: TranslationProvider,
  request: TranslationRequest,
  segments: readonly SourceSegment[],
): Promise<readonly TranslationResult[]> {
  try {
    const providerResults = await provider.translate({
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      segments,
    });
    const counts = new Map<string, number>();
    const byId = new Map<string, TranslationResult>();

    for (const result of providerResults) {
      counts.set(result.id, (counts.get(result.id) ?? 0) + 1);
      byId.set(result.id, result);
    }

    return segments.map((segment) => {
      if ((counts.get(segment.id) ?? 0) > 1) {
        return failure(
          segment,
          "DUPLICATE_RESULT",
          `The provider returned more than one result for ${segment.id}.`,
        );
      }

      return (
        byId.get(segment.id) ??
        failure(
          segment,
          "MISSING_RESULT",
          `The provider returned no result for ${segment.id}.`,
          true,
        )
      );
    });
  } catch (error) {
    const message = messageFromUnknown(error);
    return segments.map((segment) =>
      failure(
        segment,
        "TRANSLATION_FAILED",
        `The provider request failed: ${message}`,
        true,
      ),
    );
  }
}

export async function translateInBatches(
  provider: TranslationProvider,
  request: TranslationRequest,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
): Promise<readonly TranslationResult[]> {
  assertLimits(limits);
  const { batches, immediateResults } = createBatches(request.segments, limits);
  const resultsById = new Map(immediateResults);
  let nextBatchIndex = 0;

  const worker = async () => {
    for (;;) {
      const batchIndex = nextBatchIndex;
      nextBatchIndex += 1;
      const batch = batches.at(batchIndex);

      if (batch === undefined) {
        return;
      }

      const results = await translateBatch(provider, request, batch);
      for (const result of results) {
        resultsById.set(result.id, result);
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(limits.concurrency, batches.length) },
      worker,
    ),
  );

  return request.segments.map(
    (segment) =>
      resultsById.get(segment.id) ??
      failure(
        segment,
        "MISSING_RESULT",
        `No translation result was produced for ${segment.id}.`,
        true,
      ),
  );
}
