import type { RetrySettings } from "../settings/types";
import { createAbortError, throwIfAborted } from "../shared/abort";
import {
  isRecoverableProviderErrorCode,
  UserFacingError,
  type ErrorCode,
} from "../shared/errors";
import type { TranslationRequest, TranslationResult } from "../shared/types";
import type {
  TranslationProvider,
  TranslationProviderContext,
  TranslationStreamProvider,
} from "./provider";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;
const MAX_RETRY_AFTER_MS = 30_000;

// Each page batch is answered from one runtime.onMessage event in the MV3
// service worker, and Chrome documents that a single event running longer
// than 5 minutes may end the worker. Without a budget, three streaming
// attempts (each capped at 120s) plus two Retry-After waits (each capped at
// 30s) could take 420s. A new automatic attempt therefore only starts when
// its worst-case duration still fits inside this total budget, so one batch
// stays well under 5 minutes without cutting off an in-flight paid attempt.
export const DEFAULT_RETRY_TOTAL_BUDGET_MS = 270_000;
// Worst-case duration of one provider attempt: the absolute streaming cap,
// which is longer than the 30s non-streaming request timeout.
export const DEFAULT_MAX_ATTEMPT_DURATION_MS = 120_000;

export interface RetryRuntimeDependencies {
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
  now?: () => number;
  totalBudgetMs?: number;
  maxAttemptDurationMs?: number;
}

export function isAutoRetryableErrorCode(code: ErrorCode): boolean {
  return isRecoverableProviderErrorCode(code);
}

export function parseRetryAfter(
  value: string | null,
  nowMs = Date.now(),
): number | undefined {
  if (value === null) {
    return undefined;
  }
  const normalized = value.trim();
  if (/^(?:0|[1-9][0-9]*(?:\.[0-9]+)?)$/u.test(normalized)) {
    const milliseconds = Number(normalized) * 1_000;
    return Number.isFinite(milliseconds)
      ? Math.min(MAX_RETRY_AFTER_MS, Math.round(milliseconds))
      : undefined;
  }
  const dateMs = Date.parse(normalized);
  if (!Number.isFinite(dateMs) || dateMs < nowMs) {
    return undefined;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.round(dateMs - nowMs));
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.reject(createAbortError());
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
  });
}

function clampRandom(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
}

function backoffDelay(retryIndex: number, random: () => number): number {
  const exponential = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** retryIndex,
  );
  const jitterMultiplier = 0.5 + clampRandom(random());
  return Math.min(MAX_BACKOFF_MS, Math.round(exponential * jitterMultiplier));
}

function retryableReturnedFailure(
  results: readonly TranslationResult[],
): boolean {
  const failures = results.filter((result) => result.status === "failure");
  return (
    failures.length > 0 &&
    failures.every((result) => isAutoRetryableErrorCode(result.error.code))
  );
}

function retryDelay(
  retryIndex: number,
  error: unknown,
  random: () => number,
): number {
  if (
    error instanceof UserFacingError &&
    error.retryAfterMs !== undefined &&
    Number.isFinite(error.retryAfterMs) &&
    error.retryAfterMs >= 0
  ) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.round(error.retryAfterMs));
  }
  return backoffDelay(retryIndex, random);
}

function canRetryError(error: unknown): boolean {
  return (
    error instanceof UserFacingError && isAutoRetryableErrorCode(error.code)
  );
}

export async function translateWithRetry(
  provider: TranslationProvider,
  request: TranslationRequest,
  settings: RetrySettings,
  dependencies: RetryRuntimeDependencies = {},
): Promise<readonly TranslationResult[]> {
  const sleep = dependencies.sleep ?? defaultSleep;
  const random = dependencies.random ?? Math.random;
  const now = dependencies.now ?? Date.now;
  const maxRetries = settings.enabled
    ? Math.min(2, Math.max(0, Math.trunc(settings.maxRetries)))
    : 0;
  const deadline =
    now() + (dependencies.totalBudgetMs ?? DEFAULT_RETRY_TOTAL_BUDGET_MS);
  const maxAttemptMs =
    dependencies.maxAttemptDurationMs ?? DEFAULT_MAX_ATTEMPT_DURATION_MS;
  // Another paid attempt starts only if the wait plus a worst-case attempt
  // still ends before the deadline; otherwise the last outcome is final.
  const retryFits = (delayMs: number) =>
    now() + delayMs + maxAttemptMs <= deadline;

  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(dependencies.signal);

    try {
      const context: TranslationProviderContext | undefined =
        dependencies.signal === undefined
          ? undefined
          : { signal: dependencies.signal };
      const results = await provider.translate(request, context);
      throwIfAborted(dependencies.signal);
      if (!retryableReturnedFailure(results) || attempt >= maxRetries) {
        return results;
      }
      const delayMs = backoffDelay(attempt, random);
      if (!retryFits(delayMs)) {
        return results;
      }
      await sleep(delayMs, dependencies.signal);
    } catch (error) {
      if (!canRetryError(error) || attempt >= maxRetries) {
        throw error;
      }
      const delayMs = retryDelay(attempt, error, random);
      if (!retryFits(delayMs)) {
        throw error;
      }
      await sleep(delayMs, dependencies.signal);
    }
  }
}

export function createRetryingProvider(
  provider: TranslationProvider & Partial<TranslationStreamProvider>,
  settings: RetrySettings,
  dependencies: RetryRuntimeDependencies = {},
): TranslationProvider {
  const streamTranslate = provider.streamTranslate?.bind(provider);
  const retryDependencies = (
    context?: TranslationProviderContext,
  ): RetryRuntimeDependencies => ({
    ...dependencies,
    ...(context?.signal === undefined ? {} : { signal: context.signal }),
  });
  const wrapped: TranslationProvider & Partial<TranslationStreamProvider> = {
    name: provider.name,
    translate: (request, context) =>
      translateWithRetry(
        provider,
        request,
        settings,
        retryDependencies(context),
      ),
  };
  if (streamTranslate !== undefined) {
    // Streaming uses the same whole-batch retry policy as translate. Every
    // attempt keeps the caller's result callbacks; replaying a success for an
    // already-streamed segment is idempotent on the content side.
    wrapped.streamTranslate = (
      request: TranslationRequest,
      context?: TranslationProviderContext,
    ): Promise<readonly TranslationResult[]> =>
      translateWithRetry(
        {
          name: provider.name,
          translate: (attemptRequest, attemptContext) =>
            streamTranslate(attemptRequest, { ...context, ...attemptContext }),
        },
        request,
        settings,
        retryDependencies(context),
      );
  }
  return wrapped;
}
