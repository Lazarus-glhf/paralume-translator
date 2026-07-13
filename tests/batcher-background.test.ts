import { describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import { registerBackgroundMessageListener } from "../src/messaging/background-listener";
import { createBackgroundTranslationMessage } from "../src/messaging/protocol";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import { translateInBatches } from "../src/translation/batcher";
import type { TranslationProvider } from "../src/translation/provider";

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
      handleMessage(createBackgroundTranslationMessage(request)),
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
        handleMessage(createBackgroundTranslationMessage(makeRequest(texts))),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "REQUEST_LIMIT_EXCEEDED", retryable: false },
      });
      expect(translate).not.toHaveBeenCalled();
    },
  );
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
});
