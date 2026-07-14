import { createAbortError, throwIfAborted } from "../shared/abort";
import { UserFacingError } from "../shared/errors";
import type { HttpProviderDependencies } from "./http";
import { parseRetryAfter } from "./retry";

const DEFAULT_TIMEOUT_MS = 30_000;

function mapHttpError(response: Response, nowMs: number): UserFacingError {
  const retryAfterMs = parseRetryAfter(
    response.headers.get("Retry-After"),
    nowMs,
  );
  const details = retryAfterMs === undefined ? {} : { retryAfterMs };
  if (response.status === 401 || response.status === 403) {
    return new UserFacingError("AUTHENTICATION_FAILED");
  }
  if (response.status === 429) {
    return new UserFacingError("RATE_LIMITED", details);
  }
  if (response.status === 408) {
    return new UserFacingError("REQUEST_TIMEOUT", details);
  }
  if (response.status >= 500) {
    return new UserFacingError("SERVER_UNAVAILABLE", details);
  }
  return new UserFacingError("VALIDATION_ERROR");
}

export async function readServerSentEvents(
  url: string,
  init: RequestInit,
  dependencies: HttpProviderDependencies,
  onEvent: (event: unknown) => void,
  callerSignal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const fetchRequest = dependencies.fetch ?? globalThis.fetch;
  let timedOut = false;
  const didTimeout = () => timedOut;
  const onAbort = () => {
    controller.abort();
  };
  callerSignal?.addEventListener("abort", onAbort, { once: true });
  throwIfAborted(callerSignal);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    let response: Response;
    try {
      response = await fetchRequest(url, {
        ...init,
        signal: controller.signal,
      });
    } catch {
      if (callerSignal?.aborted === true) throw createAbortError();
      if (didTimeout()) throw new UserFacingError("REQUEST_TIMEOUT");
      throw new UserFacingError("NETWORK_ERROR");
    }
    if (!response.ok) {
      throw mapHttpError(response, dependencies.now?.() ?? Date.now());
    }
    const body = response.body;
    if (!body) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      throwIfAborted(callerSignal);
      if (didTimeout()) throw new UserFacingError("REQUEST_TIMEOUT");
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "" || data === "[DONE]") continue;
        try {
          onEvent(JSON.parse(data) as unknown);
        } catch (error) {
          if (error instanceof UserFacingError) throw error;
          throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
        }
      }
      if (chunk.done) break;
    }
  } catch (error) {
    if (callerSignal?.aborted === true) throw createAbortError();
    if (didTimeout()) throw new UserFacingError("REQUEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", onAbort);
  }
}
