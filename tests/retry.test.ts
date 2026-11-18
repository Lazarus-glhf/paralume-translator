import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SAFE_ERROR_MESSAGES,
  UserFacingError,
  createError,
  type ErrorCode,
} from "../src/shared/errors";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import type {
  TranslationProviderContext,
  TranslationStreamProvider,
} from "../src/translation/provider";
import {
  createRetryingProvider,
  isAutoRetryableErrorCode,
  parseRetryAfter,
  translateWithRetry,
} from "../src/translation/retry";

const request: TranslationRequest = {
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  segments: [
    { id: "segment-a", text: "First retry test segment." },
    { id: "segment-b", text: "Second retry test segment." },
  ],
};

const recoverable = new Set<ErrorCode>([
  "RATE_LIMITED",
  "REQUEST_TIMEOUT",
  "NETWORK_ERROR",
  "SERVER_UNAVAILABLE",
]);

afterEach(() => {
  vi.useRealTimers();
});

describe("automatic retry classification", () => {
  it.each(Object.keys(SAFE_ERROR_MESSAGES) as ErrorCode[])(
    "classifies %s explicitly",
    (code) => {
      expect(isAutoRetryableErrorCode(code)).toBe(recoverable.has(code));
    },
  );
});

describe("automatic whole-batch retry", () => {
  it.each([
    [false, 2, 1],
    [true, 0, 1],
    [true, 1, 2],
    [true, 2, 3],
  ] as const)(
    "uses enabled=%s maxRetries=%s for exactly %s total attempts",
    async (enabled, maxRetries, expectedAttempts) => {
      const translate = vi.fn(() =>
        Promise.reject(new UserFacingError("NETWORK_ERROR")),
      );
      const sleep = vi.fn(() => Promise.resolve());

      await expect(
        translateWithRetry(
          { name: "Transient provider", translate },
          request,
          { enabled, maxRetries },
          { sleep, random: () => 0.5 },
        ),
      ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
      expect(translate).toHaveBeenCalledTimes(expectedAttempts);
      expect(sleep).toHaveBeenCalledTimes(expectedAttempts - 1);
    },
  );

  it("uses deterministic bounded exponential backoff with jitter", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(new UserFacingError("SERVER_UNAVAILABLE"))
      .mockRejectedValueOnce(new UserFacingError("SERVER_UNAVAILABLE"))
      .mockResolvedValue([
        { id: "segment-a", status: "success", translatedText: "A" },
        { id: "segment-b", status: "success", translatedText: "B" },
      ]);
    const sleep = vi.fn(() => Promise.resolve());

    await translateWithRetry(
      { name: "Transient provider", translate },
      request,
      { enabled: true, maxRetries: 2 },
      { sleep, random: () => 0.5 },
    );

    expect(sleep).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleep).toHaveBeenNthCalledWith(2, 1_000, undefined);
  });

  it("honors a safely bounded Retry-After value when available", async () => {
    const translate = vi
      .fn()
      .mockRejectedValueOnce(
        new UserFacingError("RATE_LIMITED", { retryAfterMs: 120_000 }),
      )
      .mockResolvedValue([
        { id: "segment-a", status: "success", translatedText: "A" },
        { id: "segment-b", status: "success", translatedText: "B" },
      ]);
    const sleep = vi.fn(() => Promise.resolve());

    await translateWithRetry(
      { name: "Rate-limited provider", translate },
      request,
      { enabled: true, maxRetries: 2 },
      { sleep, random: () => 0 },
    );

    expect(sleep).toHaveBeenCalledWith(30_000, undefined);
  });

  it.each(
    (Object.keys(SAFE_ERROR_MESSAGES) as ErrorCode[]).filter(
      (code) => !recoverable.has(code),
    ),
  )("never retries permanent error %s", async (code) => {
    const translate = vi.fn(() => Promise.reject(new UserFacingError(code)));
    const sleep = vi.fn(() => Promise.resolve());

    await expect(
      translateWithRetry(
        { name: "Permanent failure provider", translate },
        request,
        { enabled: true, maxRetries: 2 },
        { sleep, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ code });
    expect(translate).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries the same whole batch without splitting or reordering IDs", async () => {
    const requests: TranslationRequest[] = [];
    const translate = vi.fn((nextRequest: TranslationRequest) => {
      requests.push(nextRequest);
      if (requests.length < 3) {
        return Promise.reject(new UserFacingError("REQUEST_TIMEOUT"));
      }
      return Promise.resolve([
        { id: "segment-b", status: "success" as const, translatedText: "B" },
        { id: "segment-a", status: "success" as const, translatedText: "A" },
      ]);
    });

    await expect(
      translateWithRetry(
        { name: "Ordered provider", translate },
        request,
        { enabled: true, maxRetries: 2 },
        { sleep: () => Promise.resolve(), random: () => 0.5 },
      ),
    ).resolves.toEqual([
      { id: "segment-b", status: "success", translatedText: "B" },
      { id: "segment-a", status: "success", translatedText: "A" },
    ]);
    expect(requests).toEqual([request, request, request]);
    expect(requests.every((attempt) => attempt.segments.length === 2)).toBe(
      true,
    );
  });

  it("retries returned transient segment failures as one whole batch", async () => {
    const translate = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "segment-a",
          status: "failure",
          error: createError("SERVER_UNAVAILABLE"),
        },
        { id: "segment-b", status: "success", translatedText: "B1" },
      ])
      .mockResolvedValue([
        { id: "segment-a", status: "success", translatedText: "A2" },
        { id: "segment-b", status: "success", translatedText: "B2" },
      ]);

    await expect(
      translateWithRetry(
        { name: "Partial transient provider", translate },
        request,
        { enabled: true, maxRetries: 2 },
        { sleep: () => Promise.resolve(), random: () => 0.5 },
      ),
    ).resolves.toMatchObject([
      { id: "segment-a", translatedText: "A2" },
      { id: "segment-b", translatedText: "B2" },
    ]);
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("stops before another attempt when cancellation aborts retry sleep", async () => {
    const controller = new AbortController();
    const translate = vi.fn(() =>
      Promise.reject(new UserFacingError("NETWORK_ERROR")),
    );
    const sleep = vi.fn((_delay: number, signal?: AbortSignal) => {
      controller.abort();
      return signal?.aborted
        ? Promise.reject(new DOMException("Aborted", "AbortError"))
        : Promise.resolve();
    });

    await expect(
      translateWithRetry(
        { name: "Cancellable provider", translate },
        request,
        { enabled: true, maxRetries: 2 },
        { sleep, random: () => 0.5, signal: controller.signal },
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(translate).toHaveBeenCalledOnce();
  });

  it("aborts the built-in retry sleep without scheduling another provider attempt", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const translate = vi.fn(() =>
      Promise.reject(new UserFacingError("SERVER_UNAVAILABLE")),
    );
    const retrying = translateWithRetry(
      { name: "Built-in cancellable sleep", translate },
      request,
      { enabled: true, maxRetries: 2 },
      { random: () => 0.5, signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(translate).toHaveBeenCalledOnce();
    });

    controller.abort();

    await expect(retrying).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(translate).toHaveBeenCalledOnce();
    expect(addListener).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalled();
  });
});

describe("total retry time budget", () => {
  // Fails like a streaming attempt that hits its 120s absolute cap.
  function slowFailingProvider(
    durationMs: number,
    error: () => UserFacingError,
  ) {
    const failedAt: number[] = [];
    const translate = vi.fn(
      () =>
        new Promise<readonly TranslationResult[]>((_resolve, reject) => {
          setTimeout(() => {
            failedAt.push(Date.now());
            reject(error());
          }, durationMs);
        }),
    );
    return { translate, failedAt };
  }

  it("keeps a batch of maximum-length streaming timeouts under five minutes", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { translate, failedAt } = slowFailingProvider(
      120_000,
      () => new UserFacingError("REQUEST_TIMEOUT"),
    );
    const retrying = translateWithRetry(
      { name: "Slow streaming provider", translate },
      request,
      { enabled: true, maxRetries: 2 },
      { random: () => 0.5 },
    );
    const outcome = retrying.catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(600_000);

    await expect(outcome).resolves.toMatchObject({ code: "REQUEST_TIMEOUT" });
    // Three attempts would run for 360s+; the third is never started.
    expect(translate).toHaveBeenCalledTimes(2);
    const elapsed = (failedAt.at(-1) ?? Number.POSITIVE_INFINITY) - startedAt;
    expect(elapsed).toBeLessThanOrEqual(270_000);
  });

  it("still waits a bounded Retry-After when the next attempt fits", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const { translate, failedAt } = slowFailingProvider(
      120_000,
      () => new UserFacingError("RATE_LIMITED", { retryAfterMs: 30_000 }),
    );
    const outcome = translateWithRetry(
      { name: "Slow rate-limited provider", translate },
      request,
      { enabled: true, maxRetries: 2 },
      { random: () => 0.5 },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(600_000);

    await expect(outcome).resolves.toMatchObject({ code: "RATE_LIMITED" });
    expect(translate).toHaveBeenCalledTimes(2);
    expect(failedAt.map((time) => time - startedAt)).toEqual([
      120_000, 270_000,
    ]);
  });

  it("keeps every allowed retry for fast transient failures", async () => {
    vi.useFakeTimers();
    const { translate } = slowFailingProvider(
      5_000,
      () => new UserFacingError("SERVER_UNAVAILABLE"),
    );
    const outcome = translateWithRetry(
      { name: "Fast failing provider", translate },
      request,
      { enabled: true, maxRetries: 2 },
      { random: () => 0.5 },
    ).catch((error: unknown) => error);

    await vi.advanceTimersByTimeAsync(60_000);

    await expect(outcome).resolves.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    expect(translate).toHaveBeenCalledTimes(3);
  });

  it("returns the last transient segment failures once no retry fits", async () => {
    let now = 0;
    const translate = vi.fn(() => {
      now += 200_000;
      return Promise.resolve<readonly TranslationResult[]>([
        {
          id: "segment-a",
          status: "failure",
          error: createError("SERVER_UNAVAILABLE"),
        },
        { id: "segment-b", status: "success", translatedText: "B" },
      ]);
    });
    const sleep = vi.fn(() => Promise.resolve());

    await expect(
      translateWithRetry(
        { name: "Slow partial provider", translate },
        request,
        { enabled: true, maxRetries: 2 },
        { sleep, random: () => 0.5, now: () => now },
      ),
    ).resolves.toMatchObject([{ status: "failure" }, { status: "success" }]);
    expect(translate).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe("retrying provider streaming path", () => {
  it("retries streamTranslate as a whole batch and forwards result callbacks on every attempt", async () => {
    const controller = new AbortController();
    const sendResult = vi.fn();
    const contexts: (TranslationProviderContext | undefined)[] = [];
    let attempts = 0;
    const streamTranslate = vi.fn(
      (
        streamRequest: TranslationRequest,
        context?: TranslationProviderContext,
      ): Promise<readonly TranslationResult[]> => {
        attempts += 1;
        contexts.push(context);
        const success = (id: string): TranslationResult => ({
          id,
          status: "success",
          translatedText: `译文 ${id}`,
        });
        context?.sendResult?.(success("segment-a"));
        if (attempts === 1) {
          return Promise.reject(new UserFacingError("NETWORK_ERROR"));
        }
        context?.sendResult?.(success("segment-b"));
        return Promise.resolve(
          streamRequest.segments.map((segment) => success(segment.id)),
        );
      },
    );
    const translate = vi.fn(() => Promise.resolve([]));
    const sleep = vi.fn(() => Promise.resolve());
    const wrapped = createRetryingProvider(
      { name: "Fake stream", translate, streamTranslate },
      { enabled: true, maxRetries: 2 },
      { sleep, random: () => 0.5 },
    ) as TranslationStreamProvider;

    await expect(
      wrapped.streamTranslate(request, {
        signal: controller.signal,
        sendResult,
      }),
    ).resolves.toHaveLength(2);
    expect(streamTranslate).toHaveBeenCalledTimes(2);
    expect(translate).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledOnce();
    expect(contexts.map((context) => context?.signal)).toEqual([
      controller.signal,
      controller.signal,
    ]);
    expect(contexts.map((context) => context?.sendResult)).toEqual([
      sendResult,
      sendResult,
    ]);
    expect(
      sendResult.mock.calls.map(
        (call: unknown[]) => (call[0] as TranslationResult).id,
      ),
    ).toEqual(["segment-a", "segment-a", "segment-b"]);
  });

  it("stops streaming retries when cancelled during backoff", async () => {
    const controller = new AbortController();
    const streamTranslate = vi.fn(() =>
      Promise.reject(new UserFacingError("RATE_LIMITED")),
    );
    const wrapped = createRetryingProvider(
      {
        name: "Fake stream",
        translate: () => Promise.resolve([]),
        streamTranslate,
      },
      { enabled: true, maxRetries: 2 },
      {
        random: () => 0.5,
        sleep: (_delayMs, signal) => {
          controller.abort();
          return signal?.aborted === true
            ? Promise.reject(new DOMException("Aborted", "AbortError"))
            : Promise.resolve();
        },
      },
    ) as TranslationStreamProvider;

    await expect(
      wrapped.streamTranslate(request, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(streamTranslate).toHaveBeenCalledOnce();
  });
});

describe("Retry-After parsing", () => {
  it("parses delta seconds and HTTP dates and rejects invalid values", () => {
    const now = Date.parse("2026-07-13T12:00:00.000Z");
    expect(parseRetryAfter("2", now)).toBe(2_000);
    expect(parseRetryAfter("Mon, 13 Jul 2026 12:00:05 GMT", now)).toBe(5_000);
    expect(parseRetryAfter("-1", now)).toBeUndefined();
    expect(parseRetryAfter("later", now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});
