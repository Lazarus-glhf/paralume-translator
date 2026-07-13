import { UserFacingError } from "../shared/errors";
import { createAbortError, throwIfAborted } from "../shared/abort";
import { parseRetryAfter } from "./retry";

export type TranslationFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpProviderDependencies {
  fetch?: TranslationFetch;
  timeoutMs?: number;
  now?: () => number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function defaultFetch(input: string, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

export async function fetchProviderJson(
  _serviceName: string,
  url: string,
  init: RequestInit,
  dependencies: HttpProviderDependencies,
  callerSignal?: AbortSignal,
): Promise<unknown> {
  const fetchRequest = dependencies.fetch ?? defaultFetch;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  throwIfAborted(callerSignal);
  const callerWasAborted = () => callerSignal?.aborted === true;
  const controller = new AbortController();
  let timedOut = false;
  const didTimeout = () => timedOut;
  const onCallerAbort = () => {
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerWasAborted()) {
    callerSignal?.removeEventListener("abort", onCallerAbort);
    throw createAbortError();
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchRequest(url, {
        ...init,
        signal: controller.signal,
      });
    } catch {
      if (callerWasAborted()) {
        throw createAbortError();
      }
      if (didTimeout()) {
        throw new UserFacingError("REQUEST_TIMEOUT");
      }
      throw new UserFacingError("NETWORK_ERROR");
    }

    throwIfAborted(callerSignal);
    if (didTimeout()) {
      throw new UserFacingError("REQUEST_TIMEOUT");
    }

    if (!response.ok) {
      const retryAfterMs = parseRetryAfter(
        response.headers.get("Retry-After"),
        dependencies.now?.() ?? Date.now(),
      );
      switch (response.status) {
        case 401:
        case 403:
          throw new UserFacingError("AUTHENTICATION_FAILED");
        case 429:
          throw new UserFacingError(
            "RATE_LIMITED",
            retryAfterMs === undefined ? {} : { retryAfterMs },
          );
        case 408:
          throw new UserFacingError(
            "REQUEST_TIMEOUT",
            retryAfterMs === undefined ? {} : { retryAfterMs },
          );
        default:
          if (response.status >= 500) {
            throw new UserFacingError(
              "SERVER_UNAVAILABLE",
              retryAfterMs === undefined ? {} : { retryAfterMs },
            );
          }
          throw new UserFacingError("VALIDATION_ERROR");
      }
    }

    try {
      const payload = (await response.json()) as unknown;
      throwIfAborted(callerSignal);
      if (didTimeout()) {
        throw new UserFacingError("REQUEST_TIMEOUT");
      }
      return payload;
    } catch (error) {
      if (callerWasAborted()) {
        throw createAbortError();
      }
      if (didTimeout()) {
        throw new UserFacingError("REQUEST_TIMEOUT");
      }
      if (
        error instanceof UserFacingError &&
        error.code === "REQUEST_TIMEOUT"
      ) {
        throw error;
      }
      throw new UserFacingError("MALFORMED_JSON");
    }
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
