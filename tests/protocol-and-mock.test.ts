import { describe, expect, it } from "vitest";

import {
  parseBackgroundMessage,
  parseBackgroundRequest,
  parseCancelTranslationResponse,
  parseContentCommand,
  parseTranslationResponse,
} from "../src/messaging/validation";
import {
  createBackgroundCancelTranslationMessage,
  createBackgroundTranslationMessage,
} from "../src/messaging/protocol";
import {
  MockTranslationProvider,
  resetMockTransientFailuresForTests,
} from "../src/translation/mock";
import type { TranslationRequest } from "../src/shared/types";
import { createError } from "../src/shared/errors";

const request: TranslationRequest = {
  sourceLanguage: "auto",
  targetLanguage: "zh-CN",
  segments: [
    { id: "segment-a", text: "A readable first paragraph." },
    { id: "segment-b", text: "A readable second paragraph." },
  ],
};

const operationId = "9a0bb651-6f5d-4f7c-9df1-cf83166d9b69";

describe("runtime protocol validation", () => {
  it.each([
    null,
    {},
    { protocolVersion: 2, target: "background", command: "translate" },
    {
      protocolVersion: 1,
      target: "background",
      command: "translate",
      request: { ...request, segments: [{ id: "", text: "Readable text" }] },
    },
    {
      protocolVersion: 1,
      target: "background",
      command: "translate",
      request: {
        ...request,
        segments: [
          { id: "duplicate", text: "First readable block." },
          { id: "duplicate", text: "Second readable block." },
        ],
      },
    },
  ])("rejects a malformed background message: %j", (message) => {
    expect(parseBackgroundRequest(message).ok).toBe(false);
  });

  it("requires an opaque UUID operation ID for translate and cancel messages", () => {
    expect(
      parseBackgroundRequest(
        createBackgroundTranslationMessage(request, operationId),
      ),
    ).toMatchObject({
      ok: true,
      value: { command: "translate", operationId },
    });
    expect(
      parseBackgroundMessage(
        createBackgroundCancelTranslationMessage(operationId),
      ),
    ).toMatchObject({
      ok: true,
      value: { command: "cancel-translation", operationId },
    });

    for (const invalidOperationId of [
      "",
      "operation-1",
      "9a0bb651-6f5d-1f7c-9df1-cf83166d9b69",
      `${operationId}unexpected`,
    ]) {
      expect(
        parseBackgroundMessage({
          protocolVersion: 1,
          target: "background",
          command: "translate",
          operationId: invalidOperationId,
          request,
        }).ok,
      ).toBe(false);
      expect(
        parseBackgroundMessage({
          protocolVersion: 1,
          target: "background",
          command: "cancel-translation",
          operationId: invalidOperationId,
        }).ok,
      ).toBe(false);
    }
  });

  it("strictly validates cancel responses", () => {
    expect(
      parseCancelTranslationResponse({
        protocolVersion: 1,
        ok: true,
        cancelled: false,
      }).ok,
    ).toBe(true);
    expect(
      parseCancelTranslationResponse({
        protocolVersion: 1,
        ok: true,
        cancelled: false,
        extra: true,
      }).ok,
    ).toBe(false);
  });

  it.each([
    undefined,
    { protocolVersion: 1, target: "content", command: "unknown" },
    {
      protocolVersion: 1,
      target: "content",
      command: "toggle",
      unexpected: true,
    },
  ])("rejects a malformed content command: %j", (message) => {
    expect(parseContentCommand(message).ok).toBe(false);
  });

  it("accepts only structurally valid translation responses", () => {
    expect(
      parseTranslationResponse({
        protocolVersion: 1,
        ok: true,
        results: [
          {
            id: "segment-a",
            status: "success",
            translatedText: "【Mock zh-CN】A readable first paragraph.",
          },
          {
            id: "segment-b",
            status: "failure",
            error: createError("TRANSLATION_FAILED"),
          },
        ],
      }).ok,
    ).toBe(true);

    expect(
      parseTranslationResponse({
        protocolVersion: 1,
        ok: true,
        results: [{ id: "segment-a", status: "success" }],
      }).ok,
    ).toBe(false);
  });
});

describe("MockTranslationProvider", () => {
  it("preserves stable IDs and input order with deterministic output", async () => {
    const provider = new MockTranslationProvider();

    const first = await provider.translate(request);
    const second = await provider.translate(request);

    expect(first).toEqual(second);
    expect(first).toEqual([
      {
        id: "segment-a",
        status: "success",
        translatedText: "【Mock zh-CN】A readable first paragraph.",
      },
      {
        id: "segment-b",
        status: "success",
        translatedText: "【Mock zh-CN】A readable second paragraph.",
      },
    ]);
  });

  it("represents a segment failure without rejecting the page request", async () => {
    const provider = new MockTranslationProvider({
      failSegmentIds: new Set(["segment-b"]),
    });

    await expect(provider.translate(request)).resolves.toEqual([
      {
        id: "segment-a",
        status: "success",
        translatedText: "【Mock zh-CN】A readable first paragraph.",
      },
      {
        id: "segment-b",
        status: "failure",
        error: createError("TRANSLATION_FAILED"),
      },
    ]);
  });

  it("provides deterministic whole-batch transient failures for retry fixtures", async () => {
    resetMockTransientFailuresForTests();
    const provider = new MockTranslationProvider();
    const transientRequest: TranslationRequest = {
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      segments: [
        {
          id: "transient-segment",
          text: "[[PARALUME_MOCK_TRANSIENT:2:SERVER_UNAVAILABLE]] Retry fixture text.",
        },
      ],
    };

    await expect(provider.translate(transientRequest)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await expect(provider.translate(transientRequest)).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
    });
    await expect(provider.translate(transientRequest)).resolves.toEqual([
      {
        id: "transient-segment",
        status: "success",
        translatedText: "【Mock zh-CN attempt 3】Retry fixture text.",
      },
    ]);
  });
});
