import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PARALUME_SOURCE_ID_ATTRIBUTE,
  PARALUME_TRANSLATION_FOR_ATTRIBUTE,
} from "../src/content/constants";
import { createContentController } from "../src/content/controller";
import { createContentRuntimeState } from "../src/content/state";
import { createContentCommand } from "../src/messaging/protocol";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import { createError } from "../src/shared/errors";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });

  return {
    promise,
    resolve(value: T) {
      if (resolvePromise === undefined) {
        throw new Error("Deferred promise was not initialized.");
      }
      resolvePromise(value);
    },
  };
}

function successResponse(results: readonly TranslationResult[]) {
  return { protocolVersion: 1 as const, ok: true as const, results };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("content controller workflow", () => {
  it("extracts, maps reordered/partial results by ID, and renders interleaved blocks", async () => {
    document.body.innerHTML = `
      <article>
        <p id="first">First readable paragraph with an <a href="https://example.com">inline link</a>.</p>
        <p id="second">Second readable paragraph for a partial failure.</p>
        <pre><code>const untouched = true;</code></pre>
      </article>
    `;
    const link = document.querySelector("#first a");
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      const [first, second] = request.segments;
      if (first === undefined || second === undefined) {
        throw new Error("Expected two extracted segments.");
      }

      return Promise.resolve({
        protocolVersion: 1,
        ok: true,
        results: [
          {
            id: second.id,
            status: "failure",
            error: createError("TRANSLATION_FAILED"),
          },
          {
            id: first.id,
            status: "success",
            translatedText: "Translated first paragraph.",
          },
        ],
      });
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "mapped-results" }),
      requestTranslations,
    });

    const response = await controller.handleMessage(
      createContentCommand("translate"),
    );

    expect(response).toMatchObject({
      ok: true,
      state: { translationCount: 2, failureCount: 1, visible: true },
    });
    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(requestTranslations.mock.calls[0]?.[0].segments).toHaveLength(2);
    expect(document.querySelector("#first a")).toBe(link);
    expect(
      document.querySelector("#first")?.nextElementSibling?.textContent,
    ).toBe("Translated first paragraph.");
    expect(
      document.querySelector("#second")?.nextElementSibling?.textContent,
    ).toBe(
      "Translation unavailable. The translation request failed. Check the provider settings and try again.",
    );
    expect(
      document.querySelectorAll("pre [data-paralume-source-id]"),
    ).toHaveLength(0);
  });

  it("makes repeated translate and repeated injection/controller creation idempotent", async () => {
    document.body.innerHTML = `<p>Readable paragraph for repeat translation.</p>`;
    const requestTranslations = vi.fn((request: TranslationRequest) =>
      Promise.resolve({
        protocolVersion: 1,
        ok: true,
        results: request.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: "Repeated-safe translation.",
        })),
      }),
    );
    const state = createContentRuntimeState({ runtimeId: "idempotent" });
    const firstController = createContentController({
      document,
      state,
      requestTranslations,
    });

    await firstController.handleMessage(createContentCommand("translate"));
    await firstController.handleMessage(createContentCommand("translate"));
    const reinjectedController = createContentController({
      document,
      state,
      requestTranslations,
    });
    await reinjectedController.handleMessage(createContentCommand("translate"));

    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(
      document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toHaveLength(1);
  });

  it("toggles visibility without invoking translation", async () => {
    document.body.innerHTML = `<p>Readable paragraph for visibility toggling.</p>`;
    const requestTranslations = vi.fn((request: TranslationRequest) =>
      Promise.resolve({
        protocolVersion: 1,
        ok: true,
        results: request.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: "Visibility-safe translation.",
        })),
      }),
    );
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "toggle" }),
      requestTranslations,
    });
    await controller.handleMessage(createContentCommand("translate"));

    const hidden = await controller.handleMessage(
      createContentCommand("toggle"),
    );
    const shown = await controller.handleMessage(
      createContentCommand("toggle"),
    );

    expect(hidden).toMatchObject({ ok: true, state: { visible: false } });
    expect(shown).toMatchObject({ ok: true, state: { visible: true } });
    expect(requestTranslations).toHaveBeenCalledOnce();
  });

  it("clear removes translations and markers and restores original structure", async () => {
    document.body.innerHTML = `
      <article>
        <p>Readable paragraph with <a href="#target">an original link</a>.</p>
        <div id="target">Original target node</div>
      </article>
    `;
    const original = document.body.innerHTML;
    const requestTranslations = vi.fn((request: TranslationRequest) =>
      Promise.resolve({
        protocolVersion: 1,
        ok: true,
        results: request.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: "Temporary translation.",
        })),
      }),
    );
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "clear" }),
      requestTranslations,
    });
    await controller.handleMessage(createContentCommand("translate"));

    const firstClear = await controller.handleMessage(
      createContentCommand("clear"),
    );
    const secondClear = await controller.handleMessage(
      createContentCommand("clear"),
    );

    expect(firstClear).toMatchObject({
      ok: true,
      state: { translationCount: 0, failureCount: 0, visible: true },
    });
    expect(secondClear).toMatchObject({
      ok: true,
      state: { translationCount: 0 },
    });
    expect(
      document.querySelector(`[${PARALUME_SOURCE_ID_ATTRIBUTE}]`),
    ).toBeNull();
    expect(document.body.innerHTML).toBe(original);
  });

  it("rejects malformed commands and malformed background responses", async () => {
    document.body.innerHTML = `<p>Readable paragraph for validation.</p>`;
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "validation" }),
      requestTranslations: () => Promise.resolve({ not: "a response" }),
    });

    await expect(
      controller.handleMessage({ command: "translate" }),
    ).resolves.toMatchObject({ ok: false, error: { code: "INVALID_MESSAGE" } });
    await expect(
      controller.handleMessage(createContentCommand("translate")),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "INVALID_MESSAGE" },
    });
  });

  it("does not expose rejected runtime exception details to page responses", async () => {
    document.body.innerHTML = `<p>Readable paragraph containing private page text.</p>`;
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "safe-runtime-error" }),
      requestTranslations: () =>
        Promise.reject(
          new Error(
            "LEAK_SECRET_c7a1 https://private.invalid LEAK_PAGE_TEXT_42",
          ),
        ),
    });

    const response = await controller.handleMessage(
      createContentCommand("translate"),
    );
    expect(response).toMatchObject({
      ok: false,
      error: createError("TRANSLATION_FAILED"),
    });
    expect(JSON.stringify(response)).not.toMatch(
      /LEAK_SECRET|private\.invalid|LEAK_PAGE_TEXT/u,
    );
  });

  it("coalesces concurrent translate commands into one provider request", async () => {
    document.body.innerHTML = `<p>Readable paragraph for a concurrent request.</p>`;
    const response = deferred<unknown>();
    let request: TranslationRequest | undefined;
    const requestTranslations = vi.fn((nextRequest: TranslationRequest) => {
      request = nextRequest;
      return response.promise;
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "concurrent" }),
      requestTranslations,
    });

    const first = controller.handleMessage(createContentCommand("translate"));
    const second = controller.handleMessage(createContentCommand("translate"));

    expect(requestTranslations).toHaveBeenCalledOnce();
    const segment = request?.segments[0];
    if (segment === undefined) {
      throw new Error("Concurrent request was not captured.");
    }
    response.resolve(
      successResponse([
        {
          id: segment.id,
          status: "success",
          translatedText: "One coalesced translation",
        },
      ]),
    );

    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(second).resolves.toMatchObject({ ok: true });
    expect(
      document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toHaveLength(1);
  });

  it("clear invalidates pending work and stale results cannot reappear", async () => {
    document.body.innerHTML = `<p>Readable paragraph with cancellable translation work.</p>`;
    const responses = [deferred<unknown>(), deferred<unknown>()];
    const requests: TranslationRequest[] = [];
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      requests.push(request);
      const next = responses[requests.length - 1];
      if (next === undefined) {
        throw new Error("Unexpected translation request.");
      }
      return next.promise;
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "generation" }),
      requestTranslations,
    });

    const staleOperation = controller.handleMessage(
      createContentCommand("translate"),
    );
    await expect(
      controller.handleMessage(createContentCommand("clear")),
    ).resolves.toMatchObject({ ok: true, state: { translationCount: 0 } });
    const freshOperation = controller.handleMessage(
      createContentCommand("translate"),
    );

    expect(requestTranslations).toHaveBeenCalledTimes(2);
    const freshSegment = requests[1]?.segments[0];
    const staleSegment = requests[0]?.segments[0];
    if (freshSegment === undefined || staleSegment === undefined) {
      throw new Error("Generation requests were not captured.");
    }
    expect(freshSegment.id).toBe(staleSegment.id);

    responses[1]?.resolve(
      successResponse([
        {
          id: freshSegment.id,
          status: "success",
          translatedText: "Fresh translation",
        },
      ]),
    );
    await expect(freshOperation).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 1 },
    });

    responses[0]?.resolve(
      successResponse([
        {
          id: staleSegment.id,
          status: "success",
          translatedText: "Stale translation",
        },
      ]),
    );
    await expect(staleOperation).resolves.toMatchObject({ ok: true });
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`)
        ?.textContent,
    ).toBe("Fresh translation");
  });

  it("uses visibility at completion when toggle runs during a pending translate", async () => {
    document.body.innerHTML = `<p id="first">First readable paragraph already translated.</p>`;
    const pending = deferred<unknown>();
    let call = 0;
    let pendingRequest: TranslationRequest | undefined;
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          successResponse(
            request.segments.map((segment) => ({
              id: segment.id,
              status: "success" as const,
              translatedText: "First translation",
            })),
          ),
        );
      }
      pendingRequest = request;
      return pending.promise;
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "pending-toggle" }),
      requestTranslations,
    });

    await controller.handleMessage(createContentCommand("translate"));
    await controller.handleMessage(createContentCommand("toggle"));
    const secondSource = document.createElement("p");
    secondSource.id = "second";
    secondSource.textContent = "Second readable paragraph added while hidden.";
    document.body.append(secondSource);
    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    await expect(
      controller.handleMessage(createContentCommand("toggle")),
    ).resolves.toMatchObject({ ok: true, state: { visible: true } });

    const segment = pendingRequest?.segments[0];
    if (segment === undefined) {
      throw new Error("Pending visibility request was not captured.");
    }
    pending.resolve(
      successResponse([
        {
          id: segment.id,
          status: "success",
          translatedText: "Second translation",
        },
      ]),
    );

    await expect(translating).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 2, visible: true },
    });
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`,
        ),
      ).every((translation) => !translation.hidden),
    ).toBe(true);
  });

  it("selects a deterministic document-order prefix within the page request budget", async () => {
    document.body.innerHTML = `
      <p id="first">First readable budget paragraph</p>
      <p id="second">Second readable budget paragraph</p>
      <p id="third">Third readable budget paragraph</p>
    `;
    const requests: TranslationRequest[] = [];
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      requests.push(request);
      return Promise.resolve(
        successResponse(
          request.segments.map((segment) => ({
            id: segment.id,
            status: "success" as const,
            translatedText: `Translated ${segment.text}`,
          })),
        ),
      );
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "page-budget" }),
      requestTranslations,
      pageRequestLimits: { maxSegments: 3, maxCharacters: 63 },
    });

    const firstResponse = await controller.handleMessage(
      createContentCommand("translate"),
    );

    expect(requests[0]?.segments.map(({ text }) => text)).toEqual([
      "First readable budget paragraph",
      "Second readable budget paragraph",
    ]);
    expect(firstResponse).toMatchObject({
      ok: true,
      state: { translationCount: 2 },
    });
    if (firstResponse.ok) {
      expect(firstResponse.message).toContain("1 additional readable block");
    }
    expect(document.querySelector("#third")?.nextElementSibling).toBeNull();

    await controller.handleMessage(createContentCommand("translate"));
    expect(requests[1]?.segments.map(({ text }) => text)).toEqual([
      "Third readable budget paragraph",
    ]);
  });
});
