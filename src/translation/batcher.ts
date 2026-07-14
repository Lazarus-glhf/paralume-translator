import {
  createError,
  sanitizeStructuredError,
  type ErrorCode,
} from "../shared/errors";
import { throwIfAborted } from "../shared/abort";
import type {
  SourceSegment,
  TranslationFailure,
  TranslationRequest,
  TranslationResult,
} from "../shared/types";
import type {
  TranslationProvider,
  TranslationStreamProvider,
} from "./provider";

export interface BatchLimits {
  maxSegments: number;
  maxCharacters: number;
  concurrency: number;
}

export const DEFAULT_BATCH_LIMITS: BatchLimits = {
  maxSegments: 40,
  maxCharacters: 12_000,
  concurrency: 1,
};

function assertLimits(limits: BatchLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }
  }
}

function failure(segment: SourceSegment, code: ErrorCode): TranslationFailure {
  return {
    id: segment.id,
    status: "failure",
    error: createError(code),
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
      immediateResults.set(segment.id, failure(segment, "SEGMENT_TOO_LARGE"));
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
  signal?: AbortSignal,
  onResult?: (result: TranslationResult) => void,
): Promise<readonly TranslationResult[]> {
  throwIfAborted(signal);
  const streamProvider = provider as Partial<TranslationStreamProvider>;
  const translate =
    onResult !== undefined && streamProvider.streamTranslate !== undefined
      ? streamProvider.streamTranslate.bind(provider)
      : provider.translate.bind(provider);
  const providerResults = await translate(
    {
      sourceLanguage: request.sourceLanguage,
      targetLanguage: request.targetLanguage,
      segments,
    },
    signal === undefined && onResult === undefined
      ? undefined
      : {
          ...(signal === undefined ? {} : { signal }),
          ...(onResult === undefined ? {} : { sendResult: onResult }),
        },
  );
  throwIfAborted(signal);
  const counts = new Map<string, number>();
  const byId = new Map<string, TranslationResult>();

  for (const result of providerResults) {
    counts.set(result.id, (counts.get(result.id) ?? 0) + 1);
    byId.set(
      result.id,
      result.status === "failure"
        ? {
            id: result.id,
            status: "failure",
            error: sanitizeStructuredError(result.error),
          }
        : result,
    );
  }

  return segments.map((segment) => {
    if ((counts.get(segment.id) ?? 0) > 1) {
      return failure(segment, "DUPLICATE_RESULT");
    }

    return byId.get(segment.id) ?? failure(segment, "MISSING_RESULT");
  });
}

export async function translateInBatches(
  provider: TranslationProvider,
  request: TranslationRequest,
  limits: BatchLimits = DEFAULT_BATCH_LIMITS,
  signal?: AbortSignal,
  onResult?: (result: TranslationResult) => void,
): Promise<readonly TranslationResult[]> {
  assertLimits(limits);
  throwIfAborted(signal);
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

      const results = await translateBatch(
        provider,
        request,
        batch,
        signal,
        onResult,
      );
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
  throwIfAborted(signal);

  return request.segments.map(
    (segment) =>
      resultsById.get(segment.id) ?? failure(segment, "MISSING_RESULT"),
  );
}
