import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PARALUME_RETRY_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
  PARALUME_TRANSLATION_FOR_ATTRIBUTE,
  PARALUME_TRANSLATION_STATUS_ATTRIBUTE,
} from "../src/content/constants";
import {
  createContentController,
  type TranslationProgress,
} from "../src/content/controller";
import { createContentRuntimeState } from "../src/content/state";
import { createContentCommand } from "../src/messaging/protocol";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import { createError } from "../src/shared/errors";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
} from "../src/settings/repository";
import type { ContentSettings } from "../src/settings/types";
import { trustedClick } from "./helpers/dom";

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
        <pre id="notes">Preformatted release notes
  stay readable.</pre>
        <pre id="code"><code>const untouched = true;</code></pre>
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
      state: { translationCount: 3, failureCount: 2, visible: true },
    });
    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(requestTranslations.mock.calls[0]?.[0].segments).toHaveLength(3);
    expect(document.querySelector("#first a")).toBe(link);
    expect(
      document.querySelector("#first")?.nextElementSibling?.textContent,
    ).toBe("Translated first paragraph.");
    expect(
      document.querySelector("#second")?.nextElementSibling?.textContent,
    ).toContain(
      "Translation unavailable. The translation request failed. Check the provider settings and try again.",
    );
    expect(
      document.querySelector("#second")?.nextElementSibling?.textContent,
    ).toContain("Retry");
    expect(
      requestTranslations.mock.calls[0]?.[0].segments.map(({ text }) => text),
    ).not.toContain("const untouched = true;");
    expect(
      document.querySelector("#notes")?.nextElementSibling?.textContent,
    ).toContain("Translation unavailable");
    expect(
      document.querySelector("#code")?.nextElementSibling ?? null,
    ).toBeNull();
    expect(
      document
        .querySelector("#code")
        ?.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE),
    ).toBe(false);
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
    const loadContentSettings = vi.fn(() =>
      Promise.resolve<ContentSettings>({
        retry: DEFAULT_RETRY_SETTINGS,
        appearance: DEFAULT_APPEARANCE_SETTINGS,
        uiLanguage: "en",
      }),
    );
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "toggle" }),
      requestTranslations,
      loadContentSettings,
    });
    await controller.handleMessage(createContentCommand("translate"));
    loadContentSettings.mockClear();

    const hidden = await controller.handleMessage(
      createContentCommand("toggle"),
    );
    const shown = await controller.handleMessage(
      createContentCommand("toggle"),
    );

    expect(hidden).toMatchObject({ ok: true, state: { visible: false } });
    expect(shown).toMatchObject({ ok: true, state: { visible: true } });
    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(loadContentSettings).not.toHaveBeenCalled();

    await controller.handleMessage(createContentCommand("toggle"));
    await expect(
      controller.handleMessage(createContentCommand("clear")),
    ).resolves.toMatchObject({
      ok: true,
      state: { visible: true },
    });
    await controller.handleMessage(createContentCommand("translate"));
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`,
        ),
      ).every((translation) => !translation.hidden),
    ).toBe(true);
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
    expect(
      document.querySelectorAll(`[${PARALUME_RETRY_ATTRIBUTE}]`),
    ).toHaveLength(0);
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
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
    expect(document.body.textContent).not.toMatch(
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

  it("discards a result when the source text changes while translation is pending", async () => {
    document.body.innerHTML = `<p id="source">Original readable paragraph before an async update.</p>`;
    const pending = deferred<unknown>();
    let request: TranslationRequest | undefined;
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "pending-source-update" }),
      requestTranslations: (nextRequest) => {
        request = nextRequest;
        return pending.promise;
      },
    });

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    const source = document.querySelector<HTMLElement>("#source");
    const segment = request?.segments[0];
    if (source === null || segment === undefined) {
      throw new Error("Pending source update fixture was not captured.");
    }
    source.textContent =
      "Replacement readable paragraph from the live application.";
    pending.resolve(
      successResponse([
        {
          id: segment.id,
          status: "success",
          translatedText: "Obsolete translation must not render",
        },
      ]),
    );

    await expect(translating).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0 },
      message: {
        id: "content.translationSummaryOmitted",
        values: { succeeded: 0, failed: 0, omitted: 1 },
      },
    });
    expect(source.nextElementSibling).toBeNull();
    expect(source.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);
  });

  it("retranslates a processed source after its text changes in place", async () => {
    document.body.innerHTML = `<p id="source">Original readable article paragraph.</p>`;
    const requests: TranslationRequest[] = [];
    const controller = createContentController({
      document,
      state: createContentRuntimeState({
        runtimeId: "processed-source-update",
      }),
      requestTranslations: (request) => {
        requests.push(request);
        return Promise.resolve(
          successResponse(
            request.segments.map((segment) => ({
              id: segment.id,
              status: "success" as const,
              translatedText: `Translated: ${segment.text}`,
            })),
          ),
        );
      },
    });

    await controller.handleMessage(createContentCommand("translate"));
    const source = document.querySelector<HTMLElement>("#source");
    if (source === null) {
      throw new Error("Processed source update fixture was not created.");
    }
    source.textContent = "Updated readable article paragraph.";

    await expect(
      controller.handleMessage(createContentCommand("translate")),
    ).resolves.toMatchObject({ ok: true, state: { translationCount: 1 } });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.segments[0]?.text).toBe(
      "Updated readable article paragraph.",
    );
    expect(source.nextElementSibling?.textContent).toBe(
      "Translated: Updated readable article paragraph.",
    );
  });

  it("applies translate=no to late results and processed sources like extraction does", async () => {
    document.body.innerHTML = `
      <section id="region">
        <p id="late">Paragraph protected while its request is pending.</p>
        <p id="processed">Paragraph protected after it was translated.</p>
      </section>
    `;
    const pending = deferred<unknown>();
    const requests: TranslationRequest[] = [];
    const respond = (request: TranslationRequest) =>
      successResponse(
        request.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: `Translated: ${segment.text}`,
        })),
      );
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "translate-no-checks" }),
      requestTranslations: (request) => {
        requests.push(request);
        return requests.length === 1
          ? Promise.resolve(respond(request))
          : pending.promise;
      },
    });
    const late = document.querySelector<HTMLElement>("#late");
    const processed = document.querySelector<HTMLElement>("#processed");
    const region = document.querySelector<HTMLElement>("#region");
    if (late === null || processed === null || region === null) {
      throw new Error("translate=no fixture was not created.");
    }

    late.setAttribute("translate", "no");
    await controller.handleMessage(createContentCommand("translate"));
    expect(requests[0]?.segments.map(({ text }) => text)).toEqual([
      "Paragraph protected after it was translated.",
    ]);

    // "yes" restores translation inside the protected region...
    late.setAttribute("translate", "YES");
    region.setAttribute("translate", "no");
    const operation = controller.handleMessage(
      createContentCommand("translate"),
    );
    await vi.waitFor(() => {
      expect(requests).toHaveLength(2);
    });
    expect(requests[1]?.segments.map(({ text }) => text)).toEqual([
      "Paragraph protected while its request is pending.",
    ]);
    // ...and the processed paragraph inherited "no", so its translation is
    // dropped instead of being reported as current.
    expect(processed.nextElementSibling).toBeNull();
    expect(processed.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);

    // An invalid value is ignored, so the page's "no" is inherited before
    // the late result arrives; the result must not be rendered.
    late.setAttribute("translate", "maybe");
    const [lateRequest] = requests.slice(1);
    if (lateRequest === undefined) {
      throw new Error("The late request was not captured.");
    }
    pending.resolve(respond(lateRequest));
    await expect(operation).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0 },
    });
    expect(late.nextElementSibling).toBe(processed);
    expect(late.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);
    expect(document.querySelector(".paralume-translation")).toBeNull();
  });

  it("uses one request for the full page to minimize RPM", async () => {
    document.body.replaceChildren(
      ...Array.from({ length: 21 }, (_, index) => {
        const paragraph = document.createElement("p");
        paragraph.id = `batch-${String(index)}`;
        paragraph.textContent = `Readable progressive paragraph number ${String(index)}.`;
        return paragraph;
      }),
    );
    const pending = [deferred<unknown>(), deferred<unknown>()];
    const requests: TranslationRequest[] = [];
    const operationIds: string[] = [];
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "progressive-batches" }),
      requestTranslations: (request, operationId) => {
        requests.push(request);
        operationIds.push(operationId);
        return (
          pending[requests.length - 1]?.promise ??
          Promise.reject(new Error("Unexpected progressive batch request."))
        );
      },
    });

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    expect(requests.map((request) => request.segments.length)).toEqual([21]);
    expect(new Set(operationIds).size).toBe(1);
    pending[0]?.resolve(
      successResponse(
        requests[0]?.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: `Translated ${segment.text}`,
        })) ?? [],
      ),
    );
    await expect(translating).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 21 },
    });
  });

  it("keeps a medium page in one request", async () => {
    document.body.replaceChildren(
      ...Array.from({ length: 15 }, (_, index) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = `Readable latency paragraph number ${String(index)}.`;
        return paragraph;
      }),
    );
    const requests: TranslationRequest[] = [];
    const pending = [deferred<unknown>(), deferred<unknown>()];
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "first-response-batch" }),
      requestTranslations(request) {
        requests.push(request);
        return (
          pending[requests.length - 1]?.promise ??
          Promise.reject(new Error("Unexpected batch"))
        );
      },
    });

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    expect(requests.map(({ segments }) => segments.length)).toEqual([15]);
    pending[0]?.resolve(
      successResponse(
        requests[0]?.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: `Fast ${segment.text}`,
        })) ?? [],
      ),
    );
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
      ).toHaveLength(15);
    });

    await expect(translating).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 15 },
    });
  });

  it("reports translating and complete progress around rendered batches", async () => {
    document.body.innerHTML = `<p>Readable paragraph for progress reporting.</p>`;
    const progress = vi.fn<(value: TranslationProgress) => void>();
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "progress-reporting" }),
      onProgress: progress,
      requestTranslations(request) {
        return Promise.resolve(
          successResponse(
            request.segments.map((segment) => ({
              id: segment.id,
              status: "success" as const,
              translatedText: "Progress translation",
            })),
          ),
        );
      },
    });

    await controller.handleMessage(createContentCommand("translate"));

    expect(progress.mock.calls.map(([value]) => value)).toEqual([
      { phase: "translating", completed: 0, total: 1 },
      { phase: "translating", completed: 1, total: 1 },
      { phase: "complete", completed: 1, total: 1 },
    ]);
  });

  it("clear invalidates pending work and stale results cannot reappear", async () => {
    document.body.innerHTML = `<p>Readable paragraph with cancellable translation work.</p>`;
    const responses = [deferred<unknown>(), deferred<unknown>()];
    const requests: TranslationRequest[] = [];
    const operationIds: string[] = [];
    const requestTranslations = vi.fn(
      (request: TranslationRequest, operationId: string) => {
        operationIds.push(operationId);
        requests.push(request);
        const next = responses[requests.length - 1];
        if (next === undefined) {
          throw new Error("Unexpected translation request.");
        }
        return next.promise;
      },
    );
    const cancelTranslation = vi.fn(() => Promise.resolve());
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "generation" }),
      requestTranslations,
      cancelTranslation,
    });

    const staleOperation = controller.handleMessage(
      createContentCommand("translate"),
    );
    await expect(
      controller.handleMessage(createContentCommand("clear")),
    ).resolves.toMatchObject({ ok: true, state: { translationCount: 0 } });
    expect(cancelTranslation).toHaveBeenCalledWith(operationIds[0]);
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

  it("clears synchronously without awaiting deferred settings and never starts stale provider work", async () => {
    document.body.innerHTML = `<p id="first">First readable paragraph for immediate clear.</p>`;
    const deferredSettings = deferred<ContentSettings>();
    const settings = {
      retry: DEFAULT_RETRY_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      uiLanguage: "en" as const,
    };
    let settingsCall = 0;
    const loadContentSettings = vi.fn(() => {
      settingsCall += 1;
      return settingsCall === 1
        ? Promise.resolve(settings)
        : deferredSettings.promise;
    });
    const operationIds: string[] = [];
    const requestTranslations = vi.fn(
      (request: TranslationRequest, operationId: string) => {
        operationIds.push(operationId);
        return Promise.resolve(
          successResponse(
            request.segments.map((segment) => ({
              id: segment.id,
              status: "success" as const,
              translatedText: "Initial translation",
            })),
          ),
        );
      },
    );
    const cancelTranslation = vi.fn(() => Promise.resolve());
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "deferred-settings" }),
      requestTranslations,
      cancelTranslation,
      loadContentSettings,
    });
    await controller.handleMessage(createContentCommand("translate"));
    const second = document.createElement("p");
    second.textContent = "Second readable paragraph awaiting settings.";
    document.body.append(second);

    const staleTranslate = controller.handleMessage(
      createContentCommand("translate"),
    );
    expect(loadContentSettings).toHaveBeenCalledTimes(2);
    const clearResponse = controller.handleMessage(
      createContentCommand("clear"),
    );

    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
    await expect(clearResponse).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0 },
    });
    expect(cancelTranslation).toHaveBeenCalledOnce();
    expect(cancelTranslation).toHaveBeenCalledWith(expect.any(String));
    expect(requestTranslations).toHaveBeenCalledOnce();

    deferredSettings.resolve(settings);
    await expect(staleTranslate).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelled" },
    });
    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Initial translation");
  });

  it("does not let stale settings from a cleared generation overwrite a fresh translation", async () => {
    document.body.innerHTML = `<p>Readable paragraph for settings generation isolation.</p>`;
    const staleSettings = deferred<ContentSettings>();
    const freshSettings = deferred<ContentSettings>();
    const loadContentSettings = vi
      .fn<() => Promise<ContentSettings>>()
      .mockReturnValueOnce(staleSettings.promise)
      .mockReturnValueOnce(freshSettings.promise);
    const requestTranslations = vi.fn((request: TranslationRequest) =>
      Promise.resolve(
        successResponse(
          request.segments.map((segment) => ({
            id: segment.id,
            status: "success" as const,
            translatedText: "Fresh settings translation",
          })),
        ),
      ),
    );
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "settings-race" }),
      requestTranslations,
      cancelTranslation: () => Promise.resolve(),
      loadContentSettings,
    });

    const stale = controller.handleMessage(createContentCommand("translate"));
    await controller.handleMessage(createContentCommand("clear"));
    const fresh = controller.handleMessage(createContentCommand("translate"));
    freshSettings.resolve({
      retry: DEFAULT_RETRY_SETTINGS,
      appearance: { ...DEFAULT_APPEARANCE_SETTINGS, fontSize: 20 },
      uiLanguage: "en",
    });
    await expect(fresh).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 1 },
    });

    staleSettings.resolve({
      retry: DEFAULT_RETRY_SETTINGS,
      appearance: { ...DEFAULT_APPEARANCE_SETTINGS, fontSize: 30 },
      uiLanguage: "zh-CN",
    });
    await expect(stale).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelled" },
    });

    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(
      document.querySelector<HTMLElement>(
        `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`,
      )?.style.fontSize,
    ).toBe("20px");
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
      expect(firstResponse.message).toEqual({
        id: "content.translationSummaryOmitted",
        values: { succeeded: 2, failed: 0, omitted: 1 },
      });
    }
    expect(document.querySelector("#third")?.nextElementSibling).toBeNull();

    await controller.handleMessage(createContentCommand("translate"));
    expect(requests[1]?.segments.map(({ text }) => text)).toEqual([
      "Third readable budget paragraph",
    ]);
  });

  it("never downgrades a streamed success when the final batch reports timeout", async () => {
    document.body.innerHTML = `<p>Readable timeout protection paragraph.</p>`;
    const response = deferred<unknown>();
    let operationId = "";
    let segment: TranslationRequest["segments"][number] | undefined;
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "stream-timeout" }),
      requestTranslations: (request, id) => {
        operationId = id;
        segment = request.segments[0];
        return response.promise;
      },
    });
    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    if (segment === undefined)
      throw new Error("Missing streamed segment fixture.");
    controller.handleStreamingResult(operationId, {
      id: segment.id,
      status: "success",
      translatedText: "Stable streamed translation",
    });
    response.resolve(
      successResponse([
        {
          id: segment.id,
          status: "failure",
          error: createError("REQUEST_TIMEOUT"),
        },
      ]),
    );
    await translating;
    expect(document.body.textContent).toContain("Stable streamed translation");
    expect(document.body.textContent).not.toContain("request timed out");
  });

  it("retries all failed segments in one request", async () => {
    document.body.innerHTML = `<p>First failed block.</p><p>Second failed block.</p>`;
    const requests: TranslationRequest[] = [];
    let call = 0;
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "bulk-retry" }),
      requestTranslations: (request) => {
        requests.push(request);
        call += 1;
        return Promise.resolve(
          successResponse(
            request.segments.map((segment): TranslationResult =>
              call === 1
                ? {
                    id: segment.id,
                    status: "failure" as const,
                    error: createError("AUTHENTICATION_FAILED"),
                  }
                : {
                    id: segment.id,
                    status: "success" as const,
                    translatedText: `Retried ${segment.text}`,
                  },
            ),
          ),
        );
      },
    });
    await controller.handleMessage(createContentCommand("translate"));
    const retried = controller.handleMessage(
      createContentCommand("retry-failed"),
    );
    const repeated = controller.handleMessage(
      createContentCommand("retry-failed"),
    );
    await Promise.all([retried, repeated]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.segments).toHaveLength(2);
    expect(document.body.textContent).toContain("Retried First failed block.");
  });

  it("manually retries only one failed segment, deduplicates clicks, and replaces it in place", async () => {
    document.body.innerHTML = `<p id="source">Readable paragraph for manual retry.</p>`;
    const manualResponse = deferred<unknown>();
    const requests: TranslationRequest[] = [];
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        return Promise.resolve(
          successResponse([
            {
              id: request.segments[0]?.id ?? "missing",
              status: "failure",
              error: createError("AUTHENTICATION_FAILED"),
            },
          ]),
        );
      }
      return manualResponse.promise;
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "manual-retry" }),
      requestTranslations,
      loadContentSettings: () =>
        Promise.resolve({
          retry: DEFAULT_RETRY_SETTINGS,
          appearance: DEFAULT_APPEARANCE_SETTINGS,
          uiLanguage: "zh-CN",
        }),
      browserUiLanguage: () => "en-US",
    });

    await controller.handleMessage(createContentCommand("translate"));
    const failure = document.querySelector<HTMLElement>(
      `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`,
    );
    if (failure === null) {
      throw new Error("Manual retry failure UI was not rendered.");
    }
    const button = failure.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );
    if (button === null) {
      throw new Error("Manual retry button was not rendered.");
    }
    expect(failure.textContent).toContain("翻译服务拒绝了已配置的凭据");

    // A page script can reach this page-DOM button; its synthetic clicks
    // must never start a provider request.
    button.click();
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(button.disabled).toBe(false);

    trustedClick(button);
    trustedClick(button);
    await vi.waitFor(() => {
      expect(requestTranslations).toHaveBeenCalledTimes(2);
    });
    expect(requests[1]?.segments).toHaveLength(1);
    expect(requests[1]?.segments[0]?.id).toBe(requests[0]?.segments[0]?.id);
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("正在重试…");

    const segment = requests[1]?.segments[0];
    if (segment === undefined) {
      throw new Error("Manual retry request was not captured.");
    }
    manualResponse.resolve(
      successResponse([
        {
          id: segment.id,
          status: "success",
          translatedText: "单段重试成功",
        },
      ]),
    );
    await vi.waitFor(() => {
      expect(failure.textContent).toBe("单段重试成功");
    });
    expect(failure.querySelector(`[${PARALUME_RETRY_ATTRIBUTE}]`)).toBeNull();
    expect(failure.hasAttribute("aria-busy")).toBe(false);
    expect(document.querySelector("#source")?.nextElementSibling).toBe(failure);
  });

  it.each([
    "API_KEY_UNCONFIGURED",
    "PERMISSION_MISSING",
    "AUTHENTICATION_FAILED",
    "VALIDATION_ERROR",
    "MALFORMED_JSON",
    "MALFORMED_PROVIDER_OUTPUT",
    "INVALID_MESSAGE",
    "INTERNAL_ERROR",
  ] as const)(
    "does not render segment Retry controls for request-global %s",
    async (code) => {
      document.body.innerHTML = `
        <p>First readable paragraph for a global failure.</p>
        <p>Second readable paragraph for a global failure.</p>
      `;
      const requestTranslations = vi.fn(() =>
        Promise.resolve({
          protocolVersion: 1,
          ok: false,
          error: createError(code),
        }),
      );
      const controller = createContentController({
        document,
        state: createContentRuntimeState({ runtimeId: `global-${code}` }),
        requestTranslations,
      });

      await expect(
        controller.handleMessage(createContentCommand("translate")),
      ).resolves.toMatchObject({ ok: false, error: { code } });
      expect(
        document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
      ).toHaveLength(0);
      expect(
        document.querySelectorAll(`[${PARALUME_RETRY_ATTRIBUTE}]`),
      ).toHaveLength(0);
      expect(requestTranslations).toHaveBeenCalledOnce();
    },
  );

  it("removes manual Retry after a legitimate segment failure is followed by a global failure", async () => {
    document.body.innerHTML = `<p>Readable paragraph for global manual retry failure.</p>`;
    let call = 0;
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          successResponse([
            {
              id: request.segments[0]?.id ?? "missing",
              status: "failure",
              error: createError("NETWORK_ERROR"),
            },
          ]),
        );
      }
      return Promise.resolve({
        protocolVersion: 1,
        ok: false,
        error: createError("PERMISSION_MISSING"),
      });
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "global-retry" }),
      requestTranslations,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const failure = document.querySelector<HTMLElement>(
      `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`,
    );
    if (failure === null) {
      throw new Error("Segment failure UI was not rendered.");
    }
    const button = failure.querySelector<HTMLButtonElement>("button");
    if (button === null) {
      throw new Error("Segment failure Retry button was not rendered.");
    }

    trustedClick(button);
    await vi.waitFor(() => {
      expect(failure.textContent).toContain(
        "Access to the configured provider origin is not granted.",
      );
    });
    expect(failure.querySelector("button")).toBeNull();
    expect(failure.hasAttribute("aria-busy")).toBe(false);
    trustedClick(button);
    expect(requestTranslations).toHaveBeenCalledTimes(2);
  });

  it("does not render a stale manual retry after Clear cancels its generation", async () => {
    document.body.innerHTML = `<p>Readable paragraph with cancellable manual retry.</p>`;
    const pending = deferred<unknown>();
    const requests: TranslationRequest[] = [];
    const operationIds: string[] = [];
    const cancelTranslation = vi.fn(() => Promise.resolve());
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "manual-clear" }),
      requestTranslations: (request, operationId) => {
        operationIds.push(operationId);
        requests.push(request);
        return requests.length === 1
          ? Promise.resolve(
              successResponse([
                {
                  id: request.segments[0]?.id ?? "missing",
                  status: "failure",
                  error: createError("NETWORK_ERROR"),
                },
              ]),
            )
          : pending.promise;
      },
      cancelTranslation,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const manualRetry = document.querySelector<HTMLButtonElement>("button");
    if (manualRetry === null) {
      throw new Error("Manual retry button was not rendered.");
    }
    trustedClick(manualRetry);
    await expect(
      controller.handleMessage(createContentCommand("clear")),
    ).resolves.toMatchObject({ ok: true, state: { translationCount: 0 } });
    expect(cancelTranslation).toHaveBeenCalledWith(operationIds[1]);

    const segment = requests[1]?.segments[0];
    if (segment === undefined) {
      throw new Error("Pending manual retry was not captured.");
    }
    pending.resolve(
      successResponse([
        {
          id: segment.id,
          status: "success",
          translatedText: "Must not reappear",
        },
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
    expect(document.body.textContent).not.toContain("Must not reappear");
  });

  it("cancels a manual retry waiting on settings before it can call the provider", async () => {
    document.body.innerHTML = `<p>Readable paragraph with deferred manual retry settings.</p>`;
    const manualSettings = deferred<ContentSettings>();
    const loadContentSettings = vi
      .fn<() => Promise<ContentSettings>>()
      .mockResolvedValueOnce({
        retry: DEFAULT_RETRY_SETTINGS,
        appearance: DEFAULT_APPEARANCE_SETTINGS,
        uiLanguage: "en",
      })
      .mockReturnValueOnce(manualSettings.promise);
    const operationIds: string[] = [];
    const requestTranslations = vi.fn(
      (request: TranslationRequest, operationId: string) => {
        operationIds.push(operationId);
        return Promise.resolve(
          successResponse([
            {
              id: request.segments[0]?.id ?? "missing",
              status: "failure",
              error: createError("NETWORK_ERROR"),
            },
          ]),
        );
      },
    );
    const cancelTranslation = vi.fn(() => Promise.resolve());
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "manual-settings-clear" }),
      requestTranslations,
      cancelTranslation,
      loadContentSettings,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const manualRetry = document.querySelector<HTMLButtonElement>("button");
    if (manualRetry === null) {
      throw new Error("Manual retry button was not rendered.");
    }
    trustedClick(manualRetry);
    await controller.handleMessage(createContentCommand("clear"));

    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(cancelTranslation).toHaveBeenCalledOnce();
    expect(cancelTranslation).not.toHaveBeenCalledWith(operationIds[0]);
    manualSettings.resolve({
      retry: DEFAULT_RETRY_SETTINGS,
      appearance: DEFAULT_APPEARANCE_SETTINGS,
      uiLanguage: "zh-CN",
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(requestTranslations).toHaveBeenCalledOnce();
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
  });

  it.each([
    "RATE_LIMITED",
    "REQUEST_TIMEOUT",
    "NETWORK_ERROR",
    "SERVER_UNAVAILABLE",
  ] as const)(
    "renders retryable failures for unfinished segments when a whole batch fails with %s",
    async (code) => {
      document.body.innerHTML = `
        <p id="streamed">Streamed readable paragraph before the batch failure.</p>
        <p id="pending-one">First pending readable paragraph in the failed batch.</p>
        <p id="pending-two">Second pending readable paragraph in the failed batch.</p>
      `;
      const requests: TranslationRequest[] = [];
      const firstResponse = deferred<unknown>();
      let firstOperationId = "";
      const progress: TranslationProgress[] = [];
      const controller = createContentController({
        document,
        state: createContentRuntimeState({ runtimeId: `batch-${code}` }),
        requestTranslations: (request, operationId) => {
          requests.push(request);
          if (requests.length === 1) {
            firstOperationId = operationId;
            return firstResponse.promise;
          }
          return Promise.resolve(
            successResponse(
              request.segments.map((segment) => ({
                id: segment.id,
                status: "success" as const,
                translatedText: `Retried ${segment.text}`,
              })),
            ),
          );
        },
        onProgress: (update) => {
          progress.push(update);
        },
      });

      const translating = controller.handleMessage(
        createContentCommand("translate"),
      );
      const streamed = requests[0]?.segments[0];
      if (streamed === undefined) {
        throw new Error("The first batch request was not captured.");
      }
      controller.handleStreamingResult(firstOperationId, {
        id: streamed.id,
        status: "success",
        translatedText: "Streamed translation survives",
      });
      firstResponse.resolve({
        protocolVersion: 1,
        ok: false,
        error: createError(code),
      });

      await expect(translating).resolves.toMatchObject({
        ok: false,
        error: { code },
      });
      expect(
        document.querySelector("#streamed")?.nextElementSibling?.textContent,
      ).toBe("Streamed translation survives");
      for (const id of ["pending-one", "pending-two"]) {
        const failure = document.querySelector(`#${id}`)?.nextElementSibling;
        expect(
          failure?.getAttribute(PARALUME_TRANSLATION_STATUS_ATTRIBUTE),
        ).toBe("failure");
        expect(
          failure?.querySelector(`[${PARALUME_RETRY_ATTRIBUTE}]`),
        ).not.toBeNull();
      }
      expect(progress).toContainEqual({
        phase: "translating",
        completed: 3,
        total: 3,
      });

      await expect(
        controller.handleMessage(createContentCommand("retry-failed")),
      ).resolves.toMatchObject({
        ok: true,
        message: { id: "content.retryFailedComplete", values: { count: 2 } },
      });
      expect(requests).toHaveLength(2);
      expect(requests[1]?.segments.map(({ id }) => id)).toEqual(
        requests[0]?.segments.slice(1).map(({ id }) => id),
      );
      expect(
        document.querySelector("#pending-one")?.nextElementSibling?.textContent,
      ).toContain("Retried First pending readable paragraph");
      expect(
        document.querySelectorAll(`[${PARALUME_RETRY_ATTRIBUTE}]`),
      ).toHaveLength(0);
    },
  );

  it.each([
    "API_KEY_UNCONFIGURED",
    "AUTHENTICATION_FAILED",
    "VALIDATION_ERROR",
    "PERMISSION_MISSING",
  ] as const)(
    "stops dispatching remaining batches after configuration failure %s",
    async (code) => {
      document.body.innerHTML = [1, 2, 3, 4]
        .map(
          (index) =>
            `<p>Readable paragraph number ${String(index)} for a configuration stop.</p>`,
        )
        .join("");
      const requestTranslations = vi
        .fn<() => Promise<unknown>>()
        .mockResolvedValueOnce({
          protocolVersion: 1,
          ok: false,
          error: createError("NETWORK_ERROR"),
        })
        .mockResolvedValue({
          protocolVersion: 1,
          ok: false,
          error: createError(code),
        });
      const progress: TranslationProgress[] = [];
      const controller = createContentController({
        document,
        state: createContentRuntimeState({ runtimeId: `config-${code}` }),
        requestTranslations,
        progressiveBatchLimits: {
          maxSegments: 1,
          maxCharacters: 12_000,
          concurrency: 1,
        },
        onProgress: (update) => {
          progress.push(update);
        },
      });

      // The actionable configuration error wins over the earlier transient one.
      await expect(
        controller.handleMessage(createContentCommand("translate")),
      ).resolves.toMatchObject({ ok: false, error: { code } });
      expect(requestTranslations).toHaveBeenCalledTimes(2);
      // Only the transient first batch gets a retryable failure.
      expect(
        document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
      ).toHaveLength(1);
      expect(
        document.querySelectorAll(`[${PARALUME_RETRY_ATTRIBUTE}]`),
      ).toHaveLength(1);
      expect(progress.at(-1)?.phase).toBe("error");
    },
  );

  it("keeps manual Retry when a single-segment retry hits a transient whole-request failure", async () => {
    document.body.innerHTML = `<p>Readable paragraph for a transient manual retry failure.</p>`;
    let call = 0;
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          successResponse([
            {
              id: request.segments[0]?.id ?? "missing",
              status: "failure",
              error: createError("NETWORK_ERROR"),
            },
          ]),
        );
      }
      return Promise.resolve({
        protocolVersion: 1,
        ok: false,
        error: createError("RATE_LIMITED"),
      });
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "transient-manual" }),
      requestTranslations,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const failure = document.querySelector<HTMLElement>(
      `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`,
    );
    if (failure === null) {
      throw new Error("Segment failure UI was not rendered.");
    }
    const firstRetry = failure.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );
    if (firstRetry === null) {
      throw new Error("Segment failure Retry button was not rendered.");
    }
    trustedClick(firstRetry);
    await vi.waitFor(() => {
      expect(failure.textContent).toContain("rate limit was reached");
    });
    const retryAgain = failure.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );
    if (retryAgain === null) {
      throw new Error("Retry was not kept after a recoverable failure.");
    }
    expect(retryAgain.disabled).toBe(false);
    trustedClick(retryAgain);
    await vi.waitFor(() => {
      expect(requestTranslations).toHaveBeenCalledTimes(3);
    });
  });

  it("keeps manual Retry when the retry request itself throws", async () => {
    document.body.innerHTML = `<p>Readable paragraph for a thrown manual retry request.</p>`;
    let call = 0;
    const requestTranslations = vi.fn((request: TranslationRequest) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve(
          successResponse([
            {
              id: request.segments[0]?.id ?? "missing",
              status: "failure",
              error: createError("NETWORK_ERROR"),
            },
          ]),
        );
      }
      if (call === 2) {
        return Promise.reject(
          new Error(
            "Could not establish connection. Receiving end does not exist.",
          ),
        );
      }
      return Promise.resolve(
        successResponse([
          {
            id: request.segments[0]?.id ?? "missing",
            status: "success",
            translatedText: "Recovered after the messaging failure",
          },
        ]),
      );
    });
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "thrown-manual" }),
      requestTranslations,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const firstRetry = document.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );
    if (firstRetry === null) {
      throw new Error("Segment failure Retry button was not rendered.");
    }
    trustedClick(firstRetry);
    await vi.waitFor(() => {
      expect(requestTranslations).toHaveBeenCalledTimes(2);
      expect(
        document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`)
          ?.textContent,
      ).toContain("The translation request failed.");
    });
    // The exception text itself is never shown.
    expect(document.body.textContent).not.toContain("Receiving end");
    const retryAgain = document.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );
    if (retryAgain === null) {
      throw new Error("Retry was lost after the retry request threw.");
    }
    expect(retryAgain.disabled).toBe(false);

    trustedClick(retryAgain);
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Recovered after the messaging failure",
      );
    });
    expect(requestTranslations).toHaveBeenCalledTimes(3);
  });

  it("does not report a late bulk retry rejection after Clear", async () => {
    document.body.innerHTML = `<p>Readable paragraph for a cancelled bulk retry.</p>`;
    let rejectRetry: ((reason: unknown) => void) | undefined;
    let call = 0;
    const progress = vi.fn<(value: TranslationProgress) => void>();
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "bulk-clear" }),
      requestTranslations: (request) => {
        call += 1;
        if (call === 1) {
          return Promise.resolve(
            successResponse([
              {
                id: request.segments[0]?.id ?? "missing",
                status: "failure",
                error: createError("NETWORK_ERROR"),
              },
            ]),
          );
        }
        return new Promise((_resolve, reject) => {
          rejectRetry = reject;
        });
      },
      cancelTranslation: () => Promise.resolve(),
      onProgress: progress,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const retrying = controller.handleMessage(
      createContentCommand("retry-failed"),
    );
    await vi.waitFor(() => {
      expect(rejectRetry).toBeDefined();
    });
    await controller.handleMessage(createContentCommand("clear"));
    expect(progress.mock.lastCall?.[0]).toEqual({
      phase: "idle",
      completed: 0,
      total: 0,
    });

    rejectRetry?.(new Error("The message port closed before a response."));

    await expect(retrying).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelled" },
    });
    expect(progress.mock.lastCall?.[0]).toEqual({
      phase: "idle",
      completed: 0,
      total: 0,
    });
  });

  it("never lowers terminal progress below segments already streamed", async () => {
    document.body.innerHTML = `
      <p>First readable paragraph streamed before failure.</p>
      <p>Second readable paragraph never translated.</p>
    `;
    const pending = deferred<unknown>();
    const progress = vi.fn<(value: TranslationProgress) => void>();
    const operations: string[] = [];
    const requests: TranslationRequest[] = [];
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "streamed-progress" }),
      requestTranslations: (request, operationId) => {
        requests.push(request);
        operations.push(operationId);
        return pending.promise;
      },
      onProgress: progress,
    });

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    const [firstSegment] = requests[0]?.segments ?? [];
    const operationId = operations[0];
    if (firstSegment === undefined || operationId === undefined) {
      throw new Error("The batch request was not captured.");
    }
    controller.handleStreamingResult(operationId, {
      id: firstSegment.id,
      status: "success",
      translatedText: "Streamed translation",
    });
    expect(progress.mock.lastCall?.[0]).toEqual({
      phase: "translating",
      completed: 1,
      total: 2,
    });

    pending.resolve({
      protocolVersion: 1,
      ok: false,
      error: createError("MALFORMED_PROVIDER_OUTPUT"),
    });

    await expect(translating).resolves.toMatchObject({
      ok: false,
      error: { code: "MALFORMED_PROVIDER_OUTPUT" },
    });
    expect(progress.mock.lastCall?.[0]).toEqual({
      phase: "error",
      completed: 1,
      total: 2,
    });
    expect(document.body.textContent).toContain("Streamed translation");
  });

  describe("source text changes around Retry", () => {
    const failFirstThen = (
      later: (request: TranslationRequest) => Promise<unknown>,
    ) => {
      const requests: TranslationRequest[] = [];
      const requestTranslations = vi.fn((request: TranslationRequest) => {
        requests.push(request);
        if (requests.length === 1) {
          return Promise.resolve(
            successResponse(
              request.segments.map((segment): TranslationResult => ({
                id: segment.id,
                status: "failure",
                error: createError("UNTRANSLATED_OUTPUT"),
              })),
            ),
          );
        }
        return later(request);
      });
      return { requests, requestTranslations };
    };

    const echoSuccess = (request: TranslationRequest) =>
      successResponse(
        request.segments.map((segment): TranslationResult => ({
          id: segment.id,
          status: "success",
          translatedText: `Translated ${segment.text}`,
        })),
      );

    const failureFor = (source: Element | null): HTMLElement => {
      const id = source?.getAttribute(PARALUME_SOURCE_ID_ATTRIBUTE);
      const failure =
        id === null || id === undefined
          ? null
          : document.querySelector<HTMLElement>(
              `[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}="${id}"]`,
            );
      if (failure === null) {
        throw new Error("Segment failure UI was not rendered.");
      }
      return failure;
    };

    const retryButton = (failure: HTMLElement): HTMLButtonElement => {
      const button = failure.querySelector<HTMLButtonElement>(
        `[${PARALUME_RETRY_ATTRIBUTE}]`,
      );
      if (button === null) {
        throw new Error("Segment Retry button was not rendered.");
      }
      return button;
    };

    it("drops a failure instead of leaving Retry pending when the source changes during a manual retry", async () => {
      document.body.innerHTML = `<p id="source">Original paragraph for a changing manual retry.</p>`;
      const manualResponse = deferred<unknown>();
      let laterCalls = 0;
      const { requests, requestTranslations } = failFirstThen((request) => {
        laterCalls += 1;
        return laterCalls === 1
          ? manualResponse.promise
          : Promise.resolve(echoSuccess(request));
      });
      const state = createContentRuntimeState({ runtimeId: "stale-manual" });
      const controller = createContentController({
        document,
        state,
        requestTranslations,
      });

      await controller.handleMessage(createContentCommand("translate"));
      const source = document.querySelector<HTMLElement>("#source");
      const failure = failureFor(source);
      const button = retryButton(failure);
      trustedClick(button);
      await vi.waitFor(() => {
        expect(requestTranslations).toHaveBeenCalledTimes(2);
      });
      expect(button.disabled).toBe(true);

      if (source === null) throw new Error("Source paragraph is missing.");
      source.textContent = "Rewritten paragraph after the retry started.";
      const segmentId = requests[1]?.segments[0]?.id ?? "missing";
      manualResponse.resolve(
        successResponse([
          {
            id: segmentId,
            status: "success",
            translatedText: "Late translation of the old text",
          },
        ]),
      );

      await vi.waitFor(() => {
        expect(failure.isConnected).toBe(false);
      });
      expect(document.body.textContent).not.toContain(
        "Late translation of the old text",
      );
      expect(document.querySelector(`[${PARALUME_RETRY_ATTRIBUTE}]`)).toBe(
        null,
      );
      expect(document.querySelector("[aria-busy]")).toBeNull();
      expect(source.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);
      expect(state.translations.size).toBe(0);

      // The rewritten source is extractable again on the next translate.
      await controller.handleMessage(createContentCommand("translate"));
      expect(requests[2]?.segments.map(({ text }) => text)).toEqual([
        "Rewritten paragraph after the retry started.",
      ]);
      expect(document.body.textContent).toContain(
        "Translated Rewritten paragraph after the retry started.",
      );
    });

    it("does not send the old text when the source changed before Retry is clicked", async () => {
      document.body.innerHTML = `<p id="source">Original paragraph before a later edit.</p>`;
      const { requestTranslations } = failFirstThen((request) =>
        Promise.resolve(echoSuccess(request)),
      );
      const controller = createContentController({
        document,
        state: createContentRuntimeState({ runtimeId: "stale-before-click" }),
        requestTranslations,
      });

      await controller.handleMessage(createContentCommand("translate"));
      const source = document.querySelector<HTMLElement>("#source");
      const failure = failureFor(source);
      const button = retryButton(failure);
      if (source === null) throw new Error("Source paragraph is missing.");
      source.textContent = "Edited paragraph that was never translated.";

      trustedClick(button);
      await vi.waitFor(() => {
        expect(failure.isConnected).toBe(false);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(requestTranslations).toHaveBeenCalledOnce();
      expect(source.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);
    });

    it("clears every pending Retry after a bulk retry where one source changed mid-request", async () => {
      document.body.innerHTML = `<p id="first">First paragraph for bulk retry.</p><p id="second">Second paragraph for bulk retry.</p>`;
      const bulkResponse = deferred<unknown>();
      const { requests, requestTranslations } = failFirstThen(
        () => bulkResponse.promise,
      );
      const controller = createContentController({
        document,
        state: createContentRuntimeState({ runtimeId: "stale-bulk" }),
        requestTranslations,
      });

      await controller.handleMessage(createContentCommand("translate"));
      const first = document.querySelector<HTMLElement>("#first");
      const second = document.querySelector<HTMLElement>("#second");
      const firstFailure = failureFor(first);
      const secondFailure = failureFor(second);
      const retrying = controller.handleMessage(
        createContentCommand("retry-failed"),
      );
      await vi.waitFor(() => {
        expect(requestTranslations).toHaveBeenCalledTimes(2);
      });
      expect(retryButton(firstFailure).disabled).toBe(true);
      expect(retryButton(secondFailure).disabled).toBe(true);

      if (second === null) throw new Error("Second paragraph is missing.");
      second.textContent = "Second paragraph rewritten during bulk retry.";
      const request = requests[1];
      if (request === undefined) throw new Error("Bulk retry not captured.");
      bulkResponse.resolve(echoSuccess(request));
      await retrying;

      expect(firstFailure.textContent).toBe(
        "Translated First paragraph for bulk retry.",
      );
      expect(secondFailure.isConnected).toBe(false);
      expect(second.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);
      expect(document.body.textContent).not.toContain(
        "Translated Second paragraph for bulk retry.",
      );
      expect(document.querySelector("[aria-busy]")).toBeNull();
      expect(document.querySelector(`[${PARALUME_RETRY_ATTRIBUTE}]`)).toBe(
        null,
      );
    });

    it("skips and drops failures whose source changed before a bulk retry", async () => {
      document.body.innerHTML = `<p id="first">First paragraph that stays.</p><p id="second">Second paragraph that changes.</p>`;
      const { requests, requestTranslations } = failFirstThen((request) =>
        Promise.resolve(echoSuccess(request)),
      );
      const controller = createContentController({
        document,
        state: createContentRuntimeState({ runtimeId: "stale-before-bulk" }),
        requestTranslations,
      });

      await controller.handleMessage(createContentCommand("translate"));
      const second = document.querySelector<HTMLElement>("#second");
      const secondFailure = failureFor(second);
      if (second === null) throw new Error("Second paragraph is missing.");
      second.textContent = "Second paragraph after an edit.";

      await controller.handleMessage(createContentCommand("retry-failed"));
      expect(requests[1]?.segments.map(({ text }) => text)).toEqual([
        "First paragraph that stays.",
      ]);
      expect(secondFailure.isConnected).toBe(false);
      expect(second.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);

      const again = await controller.handleMessage(
        createContentCommand("retry-failed"),
      );
      expect(again.ok && again.message.id).toBe("content.retryFailedEmpty");
      expect(requestTranslations).toHaveBeenCalledTimes(2);
    });
  });
});

describe("stop and resume workflow", () => {
  it("stops before the first result, excludes the late response, and reports stop cancellation", async () => {
    document.body.innerHTML = `<p>Readable paragraph waiting for its first result.</p>`;
    const pending = deferred<unknown>();
    let request: TranslationRequest | undefined;
    const cancelTranslation = vi.fn();
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "stop-before-first" }),
      requestTranslations(nextRequest) {
        request = nextRequest;
        return pending.promise;
      },
      cancelTranslation,
    });

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    await vi.waitFor(() => {
      expect(request).toBeDefined();
    });
    const stopped = await controller.handleMessage(
      createContentCommand("stop"),
    );

    expect(stopped).toMatchObject({
      ok: true,
      state: { translationCount: 0, failureCount: 0, working: false },
      message: { id: "content.stopped", values: { count: 0 } },
    });
    expect(cancelTranslation).toHaveBeenCalledOnce();
    const segment = request?.segments[0];
    if (segment === undefined) throw new Error("Translation was not captured.");
    pending.resolve(
      successResponse([
        {
          id: segment.id,
          status: "success",
          translatedText: "Late result must not render",
        },
      ]),
    );
    await expect(translating).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0, working: false },
      message: { id: "content.cancelledByStop" },
    });
    expect(document.body.textContent).not.toContain(
      "Late result must not render",
    );
  });

  it("keeps a partial streamed result, preserves hidden preference, and resumes only remaining text", async () => {
    document.body.innerHTML = `<p>First readable paragraph for a partial stop.</p><p>Second readable paragraph for a partial stop.</p>`;
    const firstResponse = deferred<unknown>();
    const requests: TranslationRequest[] = [];
    const operationIds: string[] = [];
    const requestTranslations = vi.fn(
      (request: TranslationRequest, operationId: string) => {
        requests.push(request);
        operationIds.push(operationId);
        if (requests.length === 1) return firstResponse.promise;
        return Promise.resolve(
          successResponse(
            request.segments.map((segment) => ({
              id: segment.id,
              status: "success" as const,
              translatedText: `Resumed ${segment.text}`,
            })),
          ),
        );
      },
    );
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "partial-stop-resume" }),
      requestTranslations,
      cancelTranslation: vi.fn(),
    });

    const firstRun = controller.handleMessage(
      createContentCommand("translate"),
    );
    await vi.waitFor(() => {
      expect(requests).toHaveLength(1);
    });
    const firstSegment = requests[0]?.segments[0];
    const firstOperationId = operationIds[0];
    if (firstSegment === undefined || firstOperationId === undefined) {
      throw new Error("Initial translation was not captured.");
    }
    controller.handleStreamingResult(firstOperationId, {
      id: firstSegment.id,
      status: "success",
      translatedText: "Kept streamed translation",
    });
    await controller.handleMessage(createContentCommand("toggle"));
    const stopped = await controller.handleMessage(
      createContentCommand("stop"),
    );
    expect(stopped).toMatchObject({
      ok: true,
      state: { translationCount: 1, visible: false, working: false },
    });

    const resumed = await controller.handleMessage(
      createContentCommand("translate"),
    );
    expect(requests).toHaveLength(2);
    expect(requests[1]?.segments.map(({ text }) => text)).toEqual([
      "Second readable paragraph for a partial stop.",
    ]);
    expect(resumed).toMatchObject({
      ok: true,
      state: { translationCount: 2, visible: false, working: false },
    });
    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(".paralume-translation"),
      ).every((translation) => translation.hidden),
    ).toBe(true);

    firstResponse.resolve(
      successResponse(
        requests[0]?.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: "Obsolete whole-batch result",
        })) ?? [],
      ),
    );
    await expect(firstRun).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelledByStop" },
    });
    expect(document.body.textContent).not.toContain(
      "Obsolete whole-batch result",
    );
  });

  it("stops a pending manual retry, resets Retry, and ignores its late result", async () => {
    document.body.innerHTML = `<p>Readable paragraph with a retryable failure.</p>`;
    const retryResponse = deferred<unknown>();
    let call = 0;
    const cancelTranslation = vi.fn();
    const onProgress = vi.fn();
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "manual-retry-stop" }),
      requestTranslations(request) {
        call += 1;
        const segment = request.segments[0];
        if (segment === undefined) throw new Error("Expected one segment.");
        if (call === 1) {
          return Promise.resolve(
            successResponse([
              {
                id: segment.id,
                status: "failure",
                error: createError("NETWORK_ERROR"),
              },
            ]),
          );
        }
        if (call === 2) return retryResponse.promise;
        return Promise.resolve(
          successResponse([
            {
              id: segment.id,
              status: "success",
              translatedText: "Manual retry after stop succeeded",
            },
          ]),
        );
      },
      cancelTranslation,
      onProgress,
    });

    await controller.handleMessage(createContentCommand("translate"));
    const retry = document.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );
    if (retry === null) throw new Error("Retry control was not rendered.");
    trustedClick(retry);
    await vi.waitFor(() => {
      expect(call).toBe(2);
    });
    expect(retry.disabled).toBe(true);
    expect(onProgress).toHaveBeenCalledWith({
      phase: "translating",
      completed: 0,
      total: 1,
    });

    await controller.handleMessage(createContentCommand("stop"));
    expect(retry.disabled).toBe(false);
    expect(retry.textContent).toBe("Retry");
    expect(cancelTranslation).toHaveBeenCalled();
    const marker = document
      .querySelector<HTMLElement>("p")
      ?.getAttribute(PARALUME_SOURCE_ID_ATTRIBUTE);
    if (marker === undefined || marker === null) {
      throw new Error("Segment marker is missing.");
    }
    retryResponse.resolve(
      successResponse([
        {
          id: marker,
          status: "success",
          translatedText: "Late retry result must not render",
        },
      ]),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(document.body.textContent).not.toContain(
      "Late retry result must not render",
    );
    expect(document.querySelector(`[${PARALUME_RETRY_ATTRIBUTE}]`)).toBe(retry);

    trustedClick(retry);
    await vi.waitFor(() => {
      expect(call).toBe(3);
    });
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain(
        "Manual retry after stop succeeded",
      );
    });
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "complete",
      completed: 1,
      total: 1,
    });
  });
});
