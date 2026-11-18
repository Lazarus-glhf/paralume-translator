import { afterEach, describe, expect, it, vi } from "vitest";

import { UserFacingError } from "../src/shared/errors";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import type { HttpProviderDependencies } from "../src/translation/http";
import { OpenAiTranslationProvider } from "../src/translation/openai";
import type { TranslationStreamProvider } from "../src/translation/provider";
import { createRetryingProvider } from "../src/translation/retry";
import { readServerSentEvents, SSE_STREAM_END } from "../src/translation/sse";

afterEach(() => {
  vi.useRealTimers();
});

function streamingResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

/**
 * Builds a fake fetch whose SSE body emits one chunk per scheduled delay.
 * `delayBeforeChunk(index)` returns the wait before chunk `index`, "close" to
 * end the stream, or "stall" to stop sending without closing. Like a real
 * fetch body, the stream errors when the request signal aborts.
 */
function scheduledStreamFetch(
  delayBeforeChunk: (index: number) => number | "close" | "stall",
  chunkText: (index: number) => string = (index) =>
    `data: ${JSON.stringify({ n: index })}\n\n`,
) {
  const encoder = new TextEncoder();
  const state: {
    signal: AbortSignal | undefined;
    emitted: number;
    cancelled: boolean;
  } = {
    signal: undefined,
    emitted: 0,
    cancelled: false,
  };
  const fetch = vi.fn((_url: string, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    state.signal = signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => {
            try {
              controller.error(new DOMException("Aborted", "AbortError"));
            } catch {
              // The stream already finished.
            }
          },
          { once: true },
        );
      },
      pull(controller) {
        const delay = delayBeforeChunk(state.emitted);
        if (delay === "close") {
          controller.close();
          return undefined;
        }
        if (delay === "stall") return new Promise<void>(() => undefined);
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            if (signal?.aborted !== true) {
              controller.enqueue(encoder.encode(chunkText(state.emitted)));
              state.emitted += 1;
            }
            resolve();
          }, delay);
        });
      },
      cancel() {
        state.cancelled = true;
      },
    });
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/event-stream" }),
      body,
    } as Response);
  });
  return { fetch, state };
}

function trackSettlement(promise: Promise<unknown>) {
  const tracked = { settled: false, error: undefined as unknown };
  promise.then(
    () => {
      tracked.settled = true;
    },
    (error: unknown) => {
      tracked.settled = true;
      tracked.error = error;
    },
  );
  return tracked;
}

describe("server-sent event reader", () => {
  it("joins frames split across network chunks and ignores DONE", async () => {
    const events: unknown[] = [];
    await readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      {
        fetch: () =>
          Promise.resolve(
            streamingResponse([
              'data: {"type":"response.output_text.',
              'delta","delta":"甲"}\n\n',
              "data: [DONE]\n\n",
            ]),
          ),
      },
      (event) => events.push(event),
    );

    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "甲" },
    ]);
  });
});

describe("server-sent event explicit termination", () => {
  it("ends at [DONE] and releases a connection the server keeps open", async () => {
    vi.useFakeTimers();
    const frames = [
      `data: ${JSON.stringify({ n: 0 })}\n\n`,
      "data: [DONE]\n\n",
      `data: ${JSON.stringify({ n: "after-done" })}\n\n`,
    ];
    // After [DONE] the server neither closes the stream nor sends anything.
    const { fetch, state } = scheduledStreamFetch(
      (index) => (index < 2 ? 10 : "stall"),
      (index) => frames[index] ?? "",
    );
    const events: unknown[] = [];
    const tracked = trackSettlement(
      readServerSentEvents(
        "https://example.com/stream",
        { method: "POST" },
        { fetch },
        (event) => events.push(event),
      ),
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(tracked.settled).toBe(true);
    expect(tracked.error).toBeUndefined();
    expect(events).toEqual([{ n: 0 }]);
    expect(state.cancelled).toBe(true);
    expect(state.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ends when the handler reports a terminal event and skips later frames", async () => {
    const events: unknown[] = [];
    let fetchSignal: AbortSignal | undefined;
    await readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      {
        fetch: (_url: string, init?: RequestInit) => {
          fetchSignal = init?.signal ?? undefined;
          return Promise.resolve(
            streamingResponse([
              'data: {"n":1}\n\ndata: {"type":"end"}\n\ndata: {"n":2}\n\n',
            ]),
          );
        },
      },
      (event) => {
        events.push(event);
        return (event as { type?: string }).type === "end"
          ? SSE_STREAM_END
          : undefined;
      },
    );
    expect(events).toEqual([{ n: 1 }, { type: "end" }]);
    expect(fetchSignal?.aborted).toBe(true);
  });
});

describe("server-sent event timeouts", () => {
  it("keeps an actively streaming response alive beyond the idle timeout", async () => {
    vi.useFakeTimers();
    // One chunk every 5s for 40s: longer than the 30s idle timeout in total,
    // but never idle for more than 5s.
    const { fetch } = scheduledStreamFetch((index) =>
      index < 8 ? 5_000 : "close",
    );
    const events: unknown[] = [];
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      (event) => events.push(event),
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(45_000);

    expect(tracked.settled).toBe(true);
    expect(tracked.error).toBeUndefined();
    expect(events).toHaveLength(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out and aborts the request after the stream goes idle", async () => {
    vi.useFakeTimers();
    const { fetch, state } = scheduledStreamFetch((index) =>
      index === 0 ? 10_000 : "stall",
    );
    const events: unknown[] = [];
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      (event) => events.push(event),
    );
    const tracked = trackSettlement(reading);

    // 35s after start but only 25s after the last chunk: still alive.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(tracked.settled).toBe(false);
    expect(state.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(tracked.settled).toBe(true);
    expect(tracked.error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(state.signal?.aborted).toBe(true);
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the configured timeout as the idle timeout", async () => {
    vi.useFakeTimers();
    const { fetch } = scheduledStreamFetch((index) =>
      index === 0 ? 50 : "stall",
    );
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch, timeoutMs: 100 },
      () => undefined,
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(149);
    expect(tracked.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.error).toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it("caps a continuously active stream at the maximum duration", async () => {
    vi.useFakeTimers();
    const { fetch, state } = scheduledStreamFetch(() => 5_000);
    const events: unknown[] = [];
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      (event) => events.push(event),
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(119_000);
    expect(tracked.settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(tracked.error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(state.signal?.aborted).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(23);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours a configured maximum stream duration", async () => {
    vi.useFakeTimers();
    const { fetch } = scheduledStreamFetch(() => 10);
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch, timeoutMs: 100, streamMaxDurationMs: 300 },
      () => undefined,
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(299);
    expect(tracked.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.error).toMatchObject({ code: "REQUEST_TIMEOUT" });
  });

  it("applies the idle timeout while waiting for response headers", async () => {
    vi.useFakeTimers();
    let fetchSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      () => undefined,
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(tracked.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(tracked.error).toMatchObject({ code: "REQUEST_TIMEOUT" });
    expect(fetchSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports caller cancellation as AbortError and clears both timers", async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const { fetch, state } = scheduledStreamFetch(() => 5_000);
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      () => undefined,
      caller.signal,
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(12_000);
    caller.abort();
    await vi.advanceTimersByTimeAsync(0);

    expect(tracked.error).toMatchObject({ name: "AbortError" });
    expect(state.signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("OpenAI Responses streaming timeouts", () => {
  const request: TranslationRequest = {
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    segments: [
      { id: "segment-a", text: "First readable paragraph." },
      { id: "segment-b", text: "Second readable paragraph." },
    ],
  };

  it("completes a slow but steadily streaming batch with default timeouts", async () => {
    vi.useFakeTimers();
    const output = JSON.stringify({
      t: [
        { i: "0", v: "第一段" },
        { i: "1", v: "第二段" },
      ],
    });
    // Eight deltas spaced 5s apart: 40s total, well past the old fixed 30s.
    const deltaCount = 8;
    const size = Math.ceil(output.length / deltaCount);
    const deltas = Array.from({ length: deltaCount }, (_, index) =>
      output.slice(index * size, (index + 1) * size),
    );
    const { fetch } = scheduledStreamFetch(
      (index) => (index < deltas.length ? 5_000 : "close"),
      (index) =>
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: deltas[index] ?? "",
        })}\n\n`,
    );
    const provider = new OpenAiTranslationProvider(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "model",
        protocol: "responses",
        reasoningEffort: "minimal",
      },
      { fetch },
    );
    const streamed: TranslationResult[] = [];

    const translating = provider.streamTranslate(request, {
      onResult: (result) => streamed.push(result),
    });
    const tracked = trackSettlement(translating);
    await vi.advanceTimersByTimeAsync(45_000);

    expect(tracked.error).toBeUndefined();
    await expect(translating).resolves.toEqual([
      { id: "segment-a", status: "success", translatedText: "第一段" },
      { id: "segment-b", status: "success", translatedText: "第二段" },
    ]);
    expect(streamed.map((result) => result.id)).toEqual([
      "segment-a",
      "segment-b",
    ]);
  });
});

describe("server-sent event early termination", () => {
  it("aborts the request when a later frame is not valid JSON", async () => {
    vi.useFakeTimers();
    const { fetch, state } = scheduledStreamFetch(
      (index) => (index < 2 ? 10 : "stall"),
      (index) =>
        index === 0
          ? `data: ${JSON.stringify({ n: 0 })}\n\n`
          : "data: {bad\n\n",
    );
    const events: unknown[] = [];
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      (event) => events.push(event),
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(100);

    expect(tracked.error).toMatchObject({ code: "MALFORMED_PROVIDER_OUTPUT" });
    expect(events).toEqual([{ n: 0 }]);
    expect(state.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the request when the event handler rejects an event", async () => {
    vi.useFakeTimers();
    const { fetch, state } = scheduledStreamFetch(() => 10);
    const reading = readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      { fetch },
      () => {
        throw new UserFacingError("RATE_LIMITED");
      },
    );
    const tracked = trackSettlement(reading);

    await vi.advanceTimersByTimeAsync(100);

    expect(tracked.error).toMatchObject({ code: "RATE_LIMITED" });
    expect(state.signal?.aborted).toBe(true);
    expect(state.emitted).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the request when the response status is an error", async () => {
    let fetchSignal: AbortSignal | undefined;
    const fetch = vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal ?? undefined;
      return Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
      );
    });

    await expect(
      readServerSentEvents(
        "https://example.com/stream",
        { method: "POST" },
        { fetch },
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 2_000 });
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("does not abort a stream that completed normally", async () => {
    let fetchSignal: AbortSignal | undefined;
    await readServerSentEvents(
      "https://example.com/stream",
      { method: "POST" },
      {
        fetch: (_url: string, init?: RequestInit) => {
          fetchSignal = init?.signal ?? undefined;
          return Promise.resolve(streamingResponse(['data: {"n":1}\n\n']));
        },
      },
      () => undefined,
    );
    expect(fetchSignal?.aborted).toBe(false);
  });
});

describe("OpenAI Responses stream error events", () => {
  const request: TranslationRequest = {
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    segments: [
      { id: "segment-a", text: "First readable paragraph." },
      { id: "segment-b", text: "Second readable paragraph." },
    ],
  };

  function sse(events: readonly unknown[]): string[] {
    return events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  }

  function delta(text: string) {
    return { type: "response.output_text.delta", delta: text };
  }

  function provider(fetch: NonNullable<HttpProviderDependencies["fetch"]>) {
    return new OpenAiTranslationProvider(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "model",
        protocol: "responses",
        reasoningEffort: "minimal",
      },
      { fetch },
    );
  }

  /**
   * Streams `events` 10ms apart and then stalls like a model that is still
   * generating, so only an explicit abort can end the request.
   */
  async function streamError(events: readonly unknown[]) {
    vi.useFakeTimers();
    const frames = sse(events);
    const { fetch, state } = scheduledStreamFetch(
      (index) => (index < frames.length ? 10 : "stall"),
      (index) => frames[index] ?? "",
    );
    const tracked = trackSettlement(provider(fetch).streamTranslate(request));
    await vi.advanceTimersByTimeAsync(10 * (frames.length + 1));
    expect(tracked.settled).toBe(true);
    return { error: tracked.error, state };
  }

  it("maps a rate-limited response.failed event and aborts the stream", async () => {
    const { error, state } = await streamError([
      delta('{"t":[{"i":"0",'),
      {
        type: "response.failed",
        response: {
          status: "failed",
          error: { code: "rate_limit_exceeded", message: "secret detail" },
        },
      },
    ]);
    expect(error).toMatchObject({ code: "RATE_LIMITED" });
    expect((error as Error).message).not.toContain("secret detail");
    expect(state.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("maps a server_error response.failed event to SERVER_UNAVAILABLE", async () => {
    const { error, state } = await streamError([
      {
        type: "response.failed",
        response: { status: "failed", error: { code: "server_error" } },
      },
    ]);
    expect(error).toMatchObject({ code: "SERVER_UNAVAILABLE" });
    expect(state.signal?.aborted).toBe(true);
  });

  it("maps error events and bare error objects by code or type", async () => {
    const rateLimited = await streamError([
      { type: "error", code: "rate_limit_exceeded", message: "slow down" },
    ]);
    expect(rateLimited.error).toMatchObject({ code: "RATE_LIMITED" });

    const overloaded = await streamError([
      { error: { type: "overloaded_error", message: "busy" } },
    ]);
    expect(overloaded.error).toMatchObject({ code: "SERVER_UNAVAILABLE" });

    const unknown = await streamError([
      { type: "error", code: "insufficient_quota" },
    ]);
    expect(unknown.error).toMatchObject({ code: "TRANSLATION_FAILED" });
    expect(unknown.state.signal?.aborted).toBe(true);
  });

  it("reports a truncated response.incomplete stream as incomplete output", async () => {
    vi.useFakeTimers();
    const frames = sse([
      delta('{"t":[{"i":"0","v":"第一段"},'),
      delta('{"i":"1","v":"第二'),
      {
        type: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        },
      },
    ]);
    const { fetch } = scheduledStreamFetch(
      (index) => (index < frames.length ? 10 : "close"),
      (index) => frames[index] ?? "",
    );
    const streamed: TranslationResult[] = [];
    const tracked = trackSettlement(
      provider(fetch).streamTranslate(request, {
        onResult: (result) => streamed.push(result),
      }),
    );
    await vi.advanceTimersByTimeAsync(100);

    expect(tracked.error).toMatchObject({
      code: "INCOMPLETE_PROVIDER_OUTPUT",
    });
    expect(streamed.map((result) => result.id)).toEqual(["segment-a"]);
  });

  it("keeps complete output even when the response is marked incomplete", async () => {
    const frames = sse([
      delta('{"t":[{"i":"0","v":"第一段"},{"i":"1","v":"第二段"}]}'),
      { type: "response.incomplete", response: { status: "incomplete" } },
    ]);
    const fetch = () => Promise.resolve(streamingResponse(frames));
    await expect(provider(fetch).streamTranslate(request)).resolves.toEqual([
      { id: "segment-a", status: "success", translatedText: "第一段" },
      { id: "segment-b", status: "success", translatedText: "第二段" },
    ]);
  });

  it("keeps unparseable output without an incomplete event malformed", async () => {
    const frames = sse([delta('{"t":[{"i":"0","v":"第一段"}')]);
    const fetch = () => Promise.resolve(streamingResponse(frames));
    const error: unknown = await provider(fetch)
      .streamTranslate(request)
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({ code: "MALFORMED_PROVIDER_OUTPUT" });
  });

  it("reports a non-streaming incomplete Responses payload as incomplete", async () => {
    const fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            status: "incomplete",
            incomplete_details: { reason: "content_filter" },
            output_text: '{"t":[{"i":"0","v":"第一',
          }),
          { headers: { "content-type": "application/json" } },
        ),
      );
    await expect(provider(fetch).translate(request)).rejects.toMatchObject({
      code: "INCOMPLETE_PROVIDER_OUTPUT",
    });
  });

  /**
   * Streams `events` 10ms apart, then keeps the connection open without
   * sending anything, like a compatible endpoint that does not close the
   * stream after its final event.
   */
  function heldOpenStream(events: readonly unknown[]) {
    const frames = events.map((event) =>
      event === "[DONE]" ? "data: [DONE]\n\n" : (sse([event])[0] ?? ""),
    );
    return scheduledStreamFetch(
      (index) => (index < frames.length ? 10 : "stall"),
      (index) => frames[index] ?? "",
    );
  }

  const fullOutput = '{"t":[{"i":"0","v":"第一段"},{"i":"1","v":"第二段"}]}';

  it("finishes at response.completed even when the connection stays open", async () => {
    vi.useFakeTimers();
    const { fetch, state } = heldOpenStream([
      delta(fullOutput),
      { type: "response.completed", response: { status: "completed" } },
    ]);
    const tracked = trackSettlement(provider(fetch).streamTranslate(request));

    await vi.advanceTimersByTimeAsync(100);

    expect(tracked.settled).toBe(true);
    expect(tracked.error).toBeUndefined();
    expect(state.cancelled).toBe(true);
    expect(state.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not pay for automatic retries after a held-open completed stream", async () => {
    vi.useFakeTimers();
    const { fetch } = heldOpenStream([
      delta(fullOutput),
      { type: "response.completed", response: { status: "completed" } },
    ]);
    const wrapped = createRetryingProvider(
      provider(fetch),
      { enabled: true, maxRetries: 2 },
      { random: () => 0.5 },
    ) as TranslationStreamProvider;
    const translating = wrapped.streamTranslate(request);
    const tracked = trackSettlement(translating);

    await vi.advanceTimersByTimeAsync(200_000);

    expect(tracked.error).toBeUndefined();
    await expect(translating).resolves.toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      "response.completed",
      { type: "response.completed", response: { status: "completed" } },
    ],
    ["[DONE]", "[DONE]"],
  ])(
    "rejects truncated output that ends with %s instead of succeeding",
    async (_name, terminal) => {
      vi.useFakeTimers();
      const { fetch } = heldOpenStream([
        delta('{"t":[{"i":"0","v":"第一段"},{"i":"1","v":"第'),
        terminal,
        // Never delivered: nothing after the terminal event is read.
        delta('二段"}]}'),
      ]);
      const tracked = trackSettlement(provider(fetch).streamTranslate(request));

      await vi.advanceTimersByTimeAsync(100);

      expect(tracked.settled).toBe(true);
      expect(tracked.error).toMatchObject({
        code: "MALFORMED_PROVIDER_OUTPUT",
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("still fails a response.failed event even when it follows complete output", async () => {
    vi.useFakeTimers();
    const { fetch } = heldOpenStream([
      delta(fullOutput),
      {
        type: "response.failed",
        response: { error: { code: "insufficient_quota" } },
      },
    ]);
    const tracked = trackSettlement(provider(fetch).streamTranslate(request));

    await vi.advanceTimersByTimeAsync(100);

    expect(tracked.error).toMatchObject({ code: "TRANSLATION_FAILED" });
  });

  it("automatically retries a rate-limited response.failed stream", async () => {
    let calls = 0;
    const fetch = () => {
      calls += 1;
      const frames =
        calls === 1
          ? sse([
              {
                type: "response.failed",
                response: { error: { code: "rate_limit_exceeded" } },
              },
            ])
          : sse([
              delta('{"t":[{"i":"0","v":"第一段"},{"i":"1","v":"第二段"}]}'),
            ]);
      return Promise.resolve(streamingResponse(frames));
    };
    const wrapped = createRetryingProvider(
      provider(fetch),
      { enabled: true, maxRetries: 2 },
      { sleep: () => Promise.resolve(), random: () => 0.5 },
    ) as TranslationStreamProvider;

    await expect(wrapped.streamTranslate(request)).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });
});
