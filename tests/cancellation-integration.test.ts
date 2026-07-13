import { afterEach, describe, expect, it, vi } from "vitest";

import { PARALUME_TRANSLATION_FOR_ATTRIBUTE } from "../src/content/constants";
import { createContentController } from "../src/content/controller";
import { createContentRuntimeState } from "../src/content/state";
import { createBackgroundMessageHandler } from "../src/messaging/background-handler";
import {
  createBackgroundCancelTranslationMessage,
  createBackgroundTranslationMessage,
  createContentCommand,
} from "../src/messaging/protocol";
import { UserFacingError } from "../src/shared/errors";
import type {
  TranslationRequest,
  TranslationResult,
} from "../src/shared/types";
import { OpenAiTranslationProvider } from "../src/translation/openai";
import type { TranslationProvider } from "../src/translation/provider";
import { createRetryingProvider } from "../src/translation/retry";

const sender = { tab: { id: 41 }, frameId: 0, documentId: "article-doc" };

function deferredSignal() {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      resolvePromise?.(value);
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

function createWiredController(
  provider: TranslationProvider,
  runtimeId: string,
) {
  const handleBackgroundMessage = createBackgroundMessageHandler(provider);
  const cancelTranslation = vi.fn((operationId: string) =>
    handleBackgroundMessage(
      createBackgroundCancelTranslationMessage(operationId),
      { sender },
    ),
  );
  const controller = createContentController({
    document,
    state: createContentRuntimeState({ runtimeId }),
    requestTranslations(request: TranslationRequest, operationId: string) {
      return handleBackgroundMessage(
        createBackgroundTranslationMessage(request, operationId),
        { sender },
      );
    },
    cancelTranslation,
  });
  return { cancelTranslation, controller };
}

describe("content-to-fetch cancellation integration", () => {
  it("cancels during retry sleep, observes abort, and makes zero next provider attempts", async () => {
    document.body.innerHTML = `<p>Readable paragraph waiting for an automatic retry.</p>`;
    let sleepSignal: AbortSignal | undefined;
    const sleepStarted = deferredSignal();
    const translate = vi.fn(() =>
      Promise.reject(new UserFacingError("NETWORK_ERROR")),
    );
    const provider = createRetryingProvider(
      { name: "sleeping-retry", translate },
      { enabled: true, maxRetries: 2 },
      {
        random: () => 0.5,
        sleep: (_delayMs, signal) => {
          sleepSignal = signal;
          sleepStarted.resolve();
          return new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => {
                reject(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          });
        },
      },
    );
    const { cancelTranslation, controller } = createWiredController(
      provider,
      "retry-sleep-cancel",
    );

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    await sleepStarted.promise;
    const clearing = controller.handleMessage(createContentCommand("clear"));

    expect(cancelTranslation).toHaveBeenCalledOnce();
    expect(sleepSignal?.aborted).toBe(true);
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
    await expect(clearing).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0 },
    });
    await expect(translating).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelled" },
    });
    expect(translate).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain("Translation unavailable");
  });

  it("cancels a long provider fetch and never renders its stale result", async () => {
    document.body.innerHTML = `<p>Readable paragraph waiting for a long provider fetch.</p>`;
    const fetchStarted = deferredSignal();
    let fetchSignal: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          fetchSignal = init?.signal ?? undefined;
          fetchStarted.resolve();
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const provider = new OpenAiTranslationProvider(
      {
        apiKey: "test-key",
        baseUrl: "https://api.example.com/v1",
        model: "test-model",
        protocol: "responses",
        reasoningEffort: "low",
      },
      { fetch, timeoutMs: 30_000 },
    );
    const { cancelTranslation, controller } = createWiredController(
      provider,
      "long-fetch-cancel",
    );

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    await fetchStarted.promise;
    await controller.handleMessage(createContentCommand("clear"));

    expect(cancelTranslation).toHaveBeenCalledOnce();
    expect(fetchSignal?.aborted).toBe(true);
    await expect(translating).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelled" },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
  });

  it("does not convert a cancelled operation into result-array segment failures", async () => {
    const provider: TranslationProvider = {
      name: "cancelled-result-boundary",
      translate: (
        _request: TranslationRequest,
        context?: { signal?: AbortSignal },
      ) =>
        new Promise<readonly TranslationResult[]>((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () => {
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    };
    const handle = createBackgroundMessageHandler(provider);
    const operationId = "fa3ac25d-a1a5-47e6-99d0-33886fd31b82";
    const request: TranslationRequest = {
      sourceLanguage: "auto",
      targetLanguage: "zh-CN",
      segments: [{ id: "segment-a", text: "Readable segment." }],
    };
    const pending = handle(
      createBackgroundTranslationMessage(request, operationId),
      { sender },
    );

    await handle(createBackgroundCancelTranslationMessage(operationId), {
      sender,
    });

    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
  });

  it("models a worker restart with fresh handler state and generation-rejects any late old response", async () => {
    document.body.innerHTML = `<p>Readable paragraph spanning a simulated worker restart.</p>`;
    const oldStarted = deferredSignal();
    const oldResults = deferred<readonly TranslationResult[]>();
    let oldSignal: AbortSignal | undefined;
    const oldProvider: TranslationProvider = {
      name: "old-worker-provider",
      translate: (
        _request: TranslationRequest,
        context?: { signal?: AbortSignal },
      ) => {
        oldSignal = context?.signal;
        oldStarted.resolve();
        return oldResults.promise;
      },
    };
    const newTranslate = vi.fn((request: TranslationRequest) =>
      Promise.resolve(
        request.segments.map((segment) => ({
          id: segment.id,
          status: "success" as const,
          translatedText: "New worker result",
        })),
      ),
    );
    const oldHandler = createBackgroundMessageHandler(oldProvider);
    const newHandler = createBackgroundMessageHandler({
      name: "new-worker-provider",
      translate: newTranslate,
    });
    let currentHandler = oldHandler;
    let capturedRequest: TranslationRequest | undefined;
    let capturedOperationId: string | undefined;
    let restartCancelResponse: Promise<unknown> | undefined;
    const controller = createContentController({
      document,
      state: createContentRuntimeState({ runtimeId: "worker-restart" }),
      requestTranslations(request, operationId) {
        capturedRequest = request;
        capturedOperationId = operationId;
        return currentHandler(
          createBackgroundTranslationMessage(request, operationId),
          { sender },
        );
      },
      cancelTranslation(operationId) {
        restartCancelResponse = currentHandler(
          createBackgroundCancelTranslationMessage(operationId),
          { sender },
        );
        return restartCancelResponse;
      },
    });

    const translating = controller.handleMessage(
      createContentCommand("translate"),
    );
    await oldStarted.promise;
    // A new handler instance is the restart boundary. The test deliberately
    // keeps the old promise reachable so it can stress the content generation
    // guard; a forcibly terminated Chromium worker destroys that old context.
    currentHandler = newHandler;

    await expect(
      controller.handleMessage(createContentCommand("clear")),
    ).resolves.toMatchObject({
      ok: true,
      state: { translationCount: 0 },
    });
    if (restartCancelResponse === undefined) {
      throw new Error("The restarted handler did not receive cancellation.");
    }
    await expect(restartCancelResponse).resolves.toEqual({
      protocolVersion: 1,
      ok: true,
      cancelled: false,
    });
    expect(oldSignal?.aborted).toBe(false);

    if (capturedRequest === undefined || capturedOperationId === undefined) {
      throw new Error("The pre-restart operation was not captured.");
    }
    await expect(
      newHandler(
        createBackgroundTranslationMessage(
          capturedRequest,
          capturedOperationId,
        ),
        { sender },
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "TRANSLATION_CANCELLED" },
    });
    expect(newTranslate).not.toHaveBeenCalled();

    const segment = capturedRequest.segments[0];
    if (segment === undefined) {
      throw new Error("The pre-restart segment was not captured.");
    }
    oldResults.resolve([
      {
        id: segment.id,
        status: "success",
        translatedText: "Late old-worker result must not render",
      },
    ]);
    await expect(translating).resolves.toMatchObject({
      ok: true,
      message: { id: "content.cancelled" },
    });
    expect(
      document.querySelector(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toBeNull();
    expect(document.body.textContent).not.toContain(
      "Late old-worker result must not render",
    );
  });
});
