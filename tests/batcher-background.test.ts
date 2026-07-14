import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import {
  createBackgroundCancelTranslationMessage,
  createBackgroundTranslationMessage,
} from "../src/messaging/protocol";
import { UserFacingError } from "../src/shared/errors";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import { translateInBatches } from "../src/translation/batcher";
import type { TranslationProvider } from "../src/translation/provider";

const operationIds = {
  primary: "6e875c5c-03fe-4be5-b36f-b7055c0d5df6",
  secondary: "fb156b91-71bb-4e51-b19e-b31b9ef8e8e9",
  unknown: "523ce6a6-415c-4cec-8d76-a220fc3b1d97",
} as const;

const senderA = { tab: { id: 11 }, frameId: 0, documentId: "document-a" };
const senderB = { tab: { id: 12 }, frameId: 0, documentId: "document-b" };

function makeRequest(texts: readonly string[]): TranslationRequest {
  return {
    sourceLanguage: "auto",
    targetLanguage: "zh-CN",
    segments: texts.map((text, index) => ({
      id: `segment-${String(index + 1)}`,
      text,
    })),
  };
}

function successResults(request: TranslationRequest): TranslationResult[] {
  return request.segments.map((segment) => ({
    id: segment.id,
    status: "success",
    translatedText: `Translated: ${segment.text}`,
  }));
}

function operationIdFor(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

describe("translateInBatches", () => {
  it("respects segment and character limits", async () => {
    const calls: TranslationRequest[] = [];
    const provider: TranslationProvider = {
      name: "capturing",
      translate: vi.fn((request: TranslationRequest) => {
        calls.push(request);
        return Promise.resolve(successResults(request));
      }),
    };
    const request = makeRequest([
      "1234567890",
      "abcdefghij",
      "ABCDEFGHIJ",
      "klmnopqrst",
    ]);

    await translateInBatches(provider, request, {
      maxSegments: 3,
      maxCharacters: 20,
      concurrency: 1,
    });

    expect(calls.map((call) => call.segments.length)).toEqual([2, 2]);
    expect(
      calls.map((call) =>
        call.segments.reduce(
          (total, segment) => total + segment.text.length,
          0,
        ),
      ),
    ).toEqual([20, 20]);
  });

  it("maps reordered provider output back by ID", async () => {
    const provider: TranslationProvider = {
      name: "reordering",
      translate: (request) =>
        Promise.resolve(successResults(request).toReversed()),
    };
    const request = makeRequest([
      "First readable segment",
      "Second readable segment",
      "Third readable segment",
    ]);

    const results = await translateInBatches(provider, request, {
      maxSegments: 10,
      maxCharacters: 1_000,
      concurrency: 2,
    });

    expect(results.map((result) => result.id)).toEqual([
      "segment-1",
      "segment-2",
      "segment-3",
    ]);
    expect(results[0]).toMatchObject({
      id: "segment-1",
      translatedText: "Translated: First readable segment",
    });
  });

  it("preserves successful segments when another segment fails", async () => {
    const provider: TranslationProvider = {
      name: "partial",
      translate: (request) =>
        Promise.resolve(
          request.segments.map((segment): TranslationResult =>
            segment.id === "segment-2"
              ? {
                  id: segment.id,
                  status: "failure",
                  error: {
                    code: "TRANSLATION_FAILED",
                    message: "One segment failed.",
                    retryable: false,
                  },
                }
              : {
                  id: segment.id,
                  status: "success",
                  translatedText: `Translated: ${segment.text}`,
                },
          ),
        ),
    };

    const results = await translateInBatches(
      provider,
      makeRequest(["First readable segment", "Second readable segment"]),
    );

    expect(results.map((result) => result.status)).toEqual([
      "success",
      "failure",
    ]);
  });

  it("propagates request-wide provider failures instead of manufacturing segment failures", async () => {
    const provider: TranslationProvider = {
      name: "global-failure",
      translate: () =>
        Promise.reject(new UserFacingError("AUTHENTICATION_FAILED")),
    };

    await expect(
      translateInBatches(
        provider,
        makeRequest(["First readable segment", "Second readable segment"]),
      ),
    ).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("keeps exhausted recoverable failures at request scope", async () => {
    const provider: TranslationProvider = {
      name: "recoverable-exhaustion",
      translate: () => Promise.reject(new UserFacingError("NETWORK_ERROR")),
    };

    await expect(
      translateInBatches(
        provider,
        makeRequest(["First readable segment", "Second readable segment"]),
      ),
    ).rejects.toMatchObject({ code: "NETWORK_ERROR" });
  });

  it("turns missing and duplicate provider IDs into per-segment failures", async () => {
    const provider: TranslationProvider = {
      name: "malformed-results",
      translate: () =>
        Promise.resolve([
          {
            id: "segment-1",
            status: "success",
            translatedText: "First copy",
          },
          {
            id: "segment-1",
            status: "success",
            translatedText: "Duplicate copy",
          },
        ]),
    };

    const results = await translateInBatches(
      provider,
      makeRequest(["First readable segment", "Second readable segment"]),
    );

    expect(results).toMatchObject([
      {
        id: "segment-1",
        status: "failure",
        error: { code: "DUPLICATE_RESULT" },
      },
      {
        id: "segment-2",
        status: "failure",
        error: { code: "MISSING_RESULT" },
      },
    ]);
  });

  it("rejects an oversized segment locally without exceeding provider limits", async () => {
    const translate = vi.fn(() => Promise.resolve([]));
    const provider: TranslationProvider = { name: "limited", translate };

    const results = await translateInBatches(
      provider,
      makeRequest(["This segment is longer than ten characters."]),
      { maxSegments: 2, maxCharacters: 10, concurrency: 1 },
    );

    expect(translate).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({
      id: "segment-1",
      status: "failure",
      error: { code: "SEGMENT_TOO_LARGE" },
    });
  });

  it("bounds concurrent provider calls", async () => {
    let active = 0;
    let maximumActive = 0;
    const provider: TranslationProvider = {
      name: "concurrent",
      translate: async (request) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return successResults(request);
      },
    };

    await translateInBatches(
      provider,
      makeRequest([
        "Readable block 1",
        "Readable block 2",
        "Readable block 3",
        "Readable block 4",
        "Readable block 5",
      ]),
      { maxSegments: 1, maxCharacters: 100, concurrency: 2 },
    );

    expect(maximumActive).toBe(2);
  });
});

describe("background translation message handling", () => {
  it("returns a structured error for an invalid request", async () => {
    const translate = vi.fn(() => Promise.resolve([]));
    const provider: TranslationProvider = {
      name: "unused",
      translate,
    };
    const handleMessage = createBackgroundMessageHandler(provider);

    await expect(handleMessage({ command: "translate" })).resolves.toEqual({
      protocolVersion: 1,
      ok: false,
      error: {
        code: "INVALID_MESSAGE",
        message: "The request or response was malformed.",
        retryable: false,
      },
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it("routes a valid request through the provider and returns a validated envelope", async () => {
    const provider: TranslationProvider = {
      name: "valid",
      translate: (request) => Promise.resolve(successResults(request)),
    };
    const handleMessage = createBackgroundMessageHandler(provider);
    const request = makeRequest(["Readable background segment"]);

    await expect(
      handleMessage(
        createBackgroundTranslationMessage(request, operationIds.primary),
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      results: [
        {
          id: "segment-1",
          status: "success",
          translatedText: "Translated: Readable background segment",
        },
      ],
    });
  });

  it.each([
    {
      limits: { maxSegments: 1, maxCharacters: 100 },
      texts: ["First readable segment", "Second readable segment"],
    },
    {
      limits: { maxSegments: 10, maxCharacters: 20 },
      texts: ["Readable segment longer than twenty characters"],
    },
  ])(
    "rejects requests over the total page budget before invoking the provider: $limits",
    async ({ limits, texts }) => {
      const translate = vi.fn((request: TranslationRequest) =>
        Promise.resolve(successResults(request)),
      );
      const provider: TranslationProvider = { name: "budgeted", translate };
      const handleMessage = createBackgroundMessageHandler(
        provider,
        undefined,
        limits,
      );

      await expect(
        handleMessage(
          createBackgroundTranslationMessage(
            makeRequest(texts),
            operationIds.primary,
          ),
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "REQUEST_LIMIT_EXCEEDED", retryable: false },
      });
      expect(translate).not.toHaveBeenCalled();
    },
  );

  it("deduplicates an identical active operation without another provider call", async () => {
    let resolveProvider: ((results: TranslationResult[]) => void) | undefined;
    const translate = vi.fn(
      () =>
        new Promise<TranslationResult[]>((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "deduplicated",
      translate,
    });
    const request = makeRequest(["Readable deduplication segment"]);
    const message = createBackgroundTranslationMessage(
      request,
      operationIds.primary,
    );

    const first = handleMessage(message, { sender: senderA });
    const second = handleMessage(message, { sender: senderA });
    expect(translate).toHaveBeenCalledOnce();

    resolveProvider?.(successResults(request));
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("rejects active operation ID collisions and scopes cancellation to the sender", async () => {
    let observedSignal: AbortSignal | undefined;
    const translate = vi.fn(
      (_request: TranslationRequest, context?: { signal?: AbortSignal }) =>
        new Promise<readonly TranslationResult[]>((_resolve, reject) => {
          observedSignal = context?.signal;
          context?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "scoped-cancellation",
      translate,
    });
    const request = makeRequest(["Readable cancellable segment"]);
    const active = handleMessage(
      createBackgroundTranslationMessage(request, operationIds.primary),
      { sender: senderA },
    );

    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Different text under the same operation ID"]),
          operationIds.primary,
        ),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_MESSAGE" },
    });
    await expect(
      handleMessage(
        createBackgroundCancelTranslationMessage(operationIds.primary),
        { sender: senderB },
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      cancelled: false,
    });
    expect(observedSignal?.aborted).toBe(false);
    await expect(
      handleMessage(
        createBackgroundTranslationMessage(request, operationIds.primary),
        { sender: senderB },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    expect(translate).toHaveBeenCalledOnce();

    await expect(
      handleMessage(
        createBackgroundCancelTranslationMessage(operationIds.primary),
        { sender: senderA },
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      cancelled: true,
    });
    expect(observedSignal?.aborted).toBe(true);
    await expect(active).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
  });

  it("allows the same operation UUID concurrently for different senders", async () => {
    const signals: AbortSignal[] = [];
    let resolveSecond:
      ((results: readonly TranslationResult[]) => void) | undefined;
    const translate = vi.fn(
      (request: TranslationRequest, context?: { signal?: AbortSignal }) =>
        new Promise<readonly TranslationResult[]>((resolve, reject) => {
          const signal = context?.signal;
          if (signal === undefined) {
            reject(new Error("Expected an operation abort signal."));
            return;
          }
          signals.push(signal);
          if (signals.length === 2) {
            resolveSecond = resolve;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "cross-sender-operation-id",
      translate,
    });
    const requestA = makeRequest(["Sender A request"]);
    const requestB = makeRequest(["Sender B request"]);

    const pendingA = handleMessage(
      createBackgroundTranslationMessage(requestA, operationIds.primary),
      { sender: senderA },
    );
    const pendingB = handleMessage(
      createBackgroundTranslationMessage(requestB, operationIds.primary),
      { sender: senderB },
    );

    expect(translate).toHaveBeenCalledTimes(2);
    await handleMessage(
      createBackgroundCancelTranslationMessage(operationIds.primary),
      { sender: senderA },
    );
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);

    resolveSecond?.(successResults(requestB));
    await expect(pendingA).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    await expect(pendingB).resolves.toMatchObject({ ok: true });
  });

  it("returns a safe idempotent response for unknown cancel IDs and cleans completed operations", async () => {
    const request = makeRequest(["Readable cleanup segment"]);
    const translate = vi.fn((nextRequest: TranslationRequest) =>
      Promise.resolve(successResults(nextRequest)),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "operation-cleanup",
      translate,
    });

    await expect(
      handleMessage(
        createBackgroundCancelTranslationMessage(operationIds.unknown),
        { sender: senderA },
      ),
    ).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      cancelled: false,
    });
    await handleMessage(
      createBackgroundTranslationMessage(request, operationIds.secondary),
      { sender: senderA },
    );
    await handleMessage(
      createBackgroundTranslationMessage(request, operationIds.secondary),
      { sender: senderA },
    );
    expect(translate).toHaveBeenCalledTimes(2);
  });

  it("remembers an early same-sender cancel so a reordered translate cannot start provider work", async () => {
    const translate = vi.fn((request: TranslationRequest) =>
      Promise.resolve(successResults(request)),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "early-cancel",
      translate,
    });

    await expect(
      handleMessage(
        createBackgroundCancelTranslationMessage(operationIds.primary),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({ ok: true, cancelled: false });
    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Must not reach the provider after an early cancel"]),
          operationIds.primary,
        ),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it("does not let one sender's pending cancel block the same UUID for another sender", async () => {
    const translate = vi.fn((request: TranslationRequest) =>
      Promise.resolve(successResults(request)),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "cross-sender-early-cancel",
      translate,
    });
    const request = makeRequest(["Sender-isolated pending cancellation"]);

    await handleMessage(
      createBackgroundCancelTranslationMessage(operationIds.primary),
      { sender: senderA },
    );
    await expect(
      handleMessage(
        createBackgroundTranslationMessage(request, operationIds.primary),
        { sender: senderB },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handleMessage(
        createBackgroundTranslationMessage(request, operationIds.primary),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    expect(translate).toHaveBeenCalledOnce();
  });

  it("isolates pending-cancel eviction pressure to the sender that created it", async () => {
    const translate = vi.fn((request: TranslationRequest) =>
      Promise.resolve(successResults(request)),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "pending-cancel-capacity-isolation",
      translate,
    });

    await handleMessage(
      createBackgroundCancelTranslationMessage(operationIds.primary),
      { sender: senderA },
    );
    for (let index = 1; index <= 256; index += 1) {
      await handleMessage(
        createBackgroundCancelTranslationMessage(operationIdFor(index)),
        { sender: senderB },
      );
    }

    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Sender A cancellation survives sender B pressure"]),
          operationIds.primary,
        ),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    expect(translate).not.toHaveBeenCalled();
  });

  it("bounds pending cancellations by evicting only the same sender's oldest entry", async () => {
    const translate = vi.fn((request: TranslationRequest) =>
      Promise.resolve(successResults(request)),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "bounded-pending-cancel",
      translate,
    });

    for (let index = 1; index <= 257; index += 1) {
      await handleMessage(
        createBackgroundCancelTranslationMessage(operationIdFor(index)),
        { sender: senderA },
      );
    }

    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Oldest cancellation was locally evicted"]),
          operationIdFor(1),
        ),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Newest cancellation remains pending"]),
          operationIdFor(257),
        ),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    expect(translate).toHaveBeenCalledOnce();
  });

  it("bounds pending sender scopes without evicting an existing sender", async () => {
    const translate = vi.fn((request: TranslationRequest) =>
      Promise.resolve(successResults(request)),
    );
    const handleMessage = createBackgroundMessageHandler({
      name: "bounded-pending-cancel-senders",
      translate,
    });

    await handleMessage(
      createBackgroundCancelTranslationMessage(operationIds.primary),
      { sender: senderA },
    );
    for (let index = 0; index < 63; index += 1) {
      await handleMessage(
        createBackgroundCancelTranslationMessage(operationIdFor(index + 1)),
        {
          sender: {
            tab: { id: 100 + index },
            frameId: 0,
            documentId: `capacity-document-${String(index)}`,
          },
        },
      );
    }
    const overflowSender = {
      tab: { id: 999 },
      frameId: 0,
      documentId: "overflow-document",
    };
    await handleMessage(
      createBackgroundCancelTranslationMessage(operationIds.secondary),
      { sender: overflowSender },
    );

    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Existing sender state remains retained"]),
          operationIds.primary,
        ),
        { sender: senderA },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    await expect(
      handleMessage(
        createBackgroundTranslationMessage(
          makeRequest(["Overflow sender state was not retained"]),
          operationIds.secondary,
        ),
        { sender: overflowSender },
      ),
    ).resolves.toMatchObject({ ok: true });
    expect(translate).toHaveBeenCalledOnce();
  });
});

describe("background listener registration", () => {
  it("always sends a structured response when an unexpected handler rejection escapes", async () => {
    type Listener = (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    let listener: Listener | undefined;
    const onMessage = {
      addListener: vi.fn((nextListener: Listener) => {
        listener = nextListener;
      }),
    };
    registerBackgroundMessageListener(onMessage, () =>
      Promise.reject(new Error("Unexpected listener failure")),
    );
    const sendResponse = vi.fn();

    if (listener === undefined) {
      throw new Error("Background listener was not registered.");
    }
    expect(listener({ command: "translate" }, {}, sendResponse)).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });
    expect(sendResponse).toHaveBeenCalledWith({
      protocolVersion: 1,
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: "Paralume could not complete the request.",
        retryable: true,
      },
    });
  });

  it("forwards sender context and serves translate/cancel messages through one listener", async () => {
    type Sender = typeof senderA;
    type Listener = (
      message: unknown,
      sender: Sender,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    let listener: Listener | undefined;
    const seenSenders: unknown[] = [];
    registerBackgroundMessageListener<Sender>(
      {
        addListener(next) {
          listener = next;
        },
      },
      (message, context) => {
        seenSenders.push(context.sender);
        if (
          typeof message === "object" &&
          message !== null &&
          "command" in message &&
          message.command === "cancel-translation"
        ) {
          return Promise.resolve({
            protocolVersion: 1,
            ok: true,
            cancelled: false,
          });
        }
        return Promise.resolve({ protocolVersion: 1, ok: true, results: [] });
      },
    );
    const sendResponse = vi.fn();
    if (listener === undefined) {
      throw new Error("Background listener was not registered.");
    }

    expect(
      listener(
        createBackgroundCancelTranslationMessage(operationIds.unknown),
        senderA,
        sendResponse,
      ),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledOnce();
    });
    expect(seenSenders).toEqual([senderA]);
  });

  it("keeps the runtime response channel open until in-flight handler work settles", async () => {
    type Listener = (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    let listener: Listener | undefined;
    let resolveHandler: ((response: unknown) => void) | undefined;
    registerBackgroundMessageListener(
      {
        addListener(next) {
          listener = next;
        },
      },
      () =>
        new Promise((resolve) => {
          resolveHandler = resolve;
        }),
    );
    const sendResponse = vi.fn();
    if (listener === undefined) {
      throw new Error("Background listener was not registered.");
    }

    expect(listener({ command: "translate" }, senderA, sendResponse)).toBe(
      true,
    );
    expect(sendResponse).not.toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(resolveHandler).toBeDefined();
    });
    resolveHandler?.({ protocolVersion: 1, ok: true, results: [] });
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        protocolVersion: 1,
        ok: true,
        results: [],
      });
    });
  });
});
