import { createAbortError, throwIfAborted } from "../shared/abort";
import { UserFacingError } from "../shared/errors";
import type { HttpProviderDependencies } from "./http";
import { parseRetryAfter } from "./retry";

// Streaming requests use an idle timeout: it covers waiting for response
// headers and every gap between body chunks, and is reset whenever bytes
// arrive. A separate absolute cap bounds a stream that keeps trickling data.
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_DURATION_MS = 120_000;

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

/**
 * Returned by an event handler when the event is a protocol-level terminal
 * event (for example Responses `response.completed`). Reading stops at once
 * and the connection is released instead of waiting for the server to close
 * it; some compatible endpoints keep the connection open after the final
 * event, which would otherwise turn a finished response into an idle timeout.
 */
export const SSE_STREAM_END: unique symbol = Symbol("paralume.sse.end");

/**
 * Reads an SSE response and passes each JSON `data:` payload to `onEvent`.
 * The stream ends at EOF, at a `[DONE]` sentinel, or when `onEvent` returns
 * `SSE_STREAM_END`; any other return value is ignored.
 */
export async function readServerSentEvents(
  url: string,
  init: RequestInit,
  dependencies: HttpProviderDependencies,
  onEvent: (event: unknown) => unknown,
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
  const idleTimeoutMs = dependencies.timeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const fireTimeout = () => {
    timedOut = true;
    controller.abort();
  };
  let idleTimeout = setTimeout(fireTimeout, idleTimeoutMs);
  const maxDuration = setTimeout(
    fireTimeout,
    dependencies.streamMaxDurationMs ?? DEFAULT_MAX_DURATION_MS,
  );
  const markActivity = () => {
    if (didTimeout()) return;
    clearTimeout(idleTimeout);
    idleTimeout = setTimeout(fireTimeout, idleTimeoutMs);
  };

  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  // Set when the stream ended on a terminal event before the server closed it.
  let endedEarly = false;
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
    markActivity();
    reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      throwIfAborted(callerSignal);
      if (didTimeout()) throw new UserFacingError("REQUEST_TIMEOUT");
      if (chunk.value !== undefined && chunk.value.byteLength > 0) {
        markActivity();
      }
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      const frames = buffer.split(/\r?\n\r?\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        const data = frame
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (data === "") continue;
        if (data === "[DONE]") {
          endedEarly = true;
          break;
        }
        let control: unknown;
        try {
          control = onEvent(JSON.parse(data) as unknown);
        } catch (error) {
          if (error instanceof UserFacingError) throw error;
          throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
        }
        if (control === SSE_STREAM_END) {
          endedEarly = true;
          break;
        }
      }
      // Frames after a terminal event are never delivered.
      if (endedEarly || chunk.done) break;
    }
    completed = true;
  } catch (error) {
    if (callerSignal?.aborted === true) throw createAbortError();
    if (didTimeout()) throw new UserFacingError("REQUEST_TIMEOUT");
    throw error;
  } finally {
    clearTimeout(idleTimeout);
    clearTimeout(maxDuration);
    callerSignal?.removeEventListener("abort", onAbort);
    if (!completed) {
      // Any early exit (HTTP error, malformed or provider-reported error
      // event) must stop the download so the provider stops generating.
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    } else if (endedEarly) {
      // The protocol said the response is over; release the connection
      // rather than leaving it open until the server decides to close it.
      void reader?.cancel().catch(() => undefined);
      controller.abort();
    }
  }
}
