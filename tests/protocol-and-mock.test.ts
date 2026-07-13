import { describe, expect, it } from "vitest";

import {
  parseBackgroundRequest,
  parseContentCommand,
  parseTranslationResponse,
} from "../src/messaging/validation";
import { MockTranslationProvider } from "../src/translation/mock";
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
});
