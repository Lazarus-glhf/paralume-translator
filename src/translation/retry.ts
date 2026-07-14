import type { RetrySettings } from "../settings/types";
import { createAbortError, throwIfAborted } from "../shared/abort";
import { UserFacingError, type ErrorCode } from "../shared/errors";
import type { TranslationRequest, TranslationResult } from "../shared/types";
import type {
  TranslationProvider,
  TranslationProviderContext,
  TranslationStreamProvider,
} from "./provider";

const AUTO_RETRYABLE_ERROR_CODES: ReadonlySet<ErrorCode> = new Set([
  "RATE_LIMITED",
  "REQUEST_TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_UNAVAILABLE",
]);

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 5_000;
const MAX_RETRY_AFTER_MS = 30_000;

export interface RetryRuntimeDependencies {
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  signal?: AbortSignal;
}

export function isAutoRetryableErrorCode(code: ErrorCode): boolean {
  return AUTO_RETRYABLE_ERROR_CODES.has(code);
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
  const maxRetries = settings.enabled
    ? Math.min(2, Math.max(0, Math.trunc(settings.maxRetries)))
    : 0;

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
      await sleep(backoffDelay(attempt, random), dependencies.signal);
    } catch (error) {
      if (!canRetryError(error) || attempt >= maxRetries) {
        throw error;
      }
      await sleep(retryDelay(attempt, error, random), dependencies.signal);
    }
  }
}

export function createRetryingProvider(
  provider: TranslationProvider,
  settings: RetrySettings,
  dependencies: RetryRuntimeDependencies = {},
): TranslationProvider {
  const streamProvider = provider as Partial<TranslationStreamProvider>;
  const wrapped: TranslationProvider & Partial<TranslationStreamProvider> = {
    name: provider.name,
    translate: (request, context) =>
      translateWithRetry(provider, request, settings, {
        ...dependencies,
        ...(context?.signal === undefined ? {} : { signal: context.signal }),
      }),
    ...(streamProvider.streamTranslate === undefined
      ? {}
      : {
          streamTranslate: streamProvider.streamTranslate.bind(provider),
        }),
  };
  return wrapped;
}
