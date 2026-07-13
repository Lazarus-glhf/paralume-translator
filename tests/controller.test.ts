import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PARALUME_RETRY_ATTRIBUTE,
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
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
} from "../src/settings/repository";
import type { ContentSettings } from "../src/settings/types";

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
    ).toContain(
      "Translation unavailable. The translation request failed. Check the provider settings and try again.",
    );
    expect(
      document.querySelector("#second")?.nextElementSibling?.textContent,
    ).toContain("Retry");
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

    button.click();
    button.click();
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

    button.click();
    await vi.waitFor(() => {
      expect(failure.textContent).toContain(
        "Access to the configured provider origin is not granted.",
      );
    });
    expect(failure.querySelector("button")).toBeNull();
    expect(failure.hasAttribute("aria-busy")).toBe(false);
    button.click();
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
    document.querySelector<HTMLButtonElement>("button")?.click();
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
    document.querySelector<HTMLButtonElement>("button")?.click();
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
});
