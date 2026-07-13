import {
  createMessage,
  resolveUiLocale,
  type MessageDescriptor,
  type UiLocale,
} from "../localization";
import {
  PROTOCOL_VERSION,
  createErrorResponse,
  createOperationId,
  type ContentResponse,
} from "../messaging/protocol";
import {
  parseContentCommand,
  parseTranslationResponse,
} from "../messaging/validation";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
} from "../settings/defaults";
import type { ContentSettings } from "../settings/types";
import {
  createError,
  sanitizeError,
  type StructuredError,
} from "../shared/errors";
import {
  countPageRequestPrefix,
  DEFAULT_PAGE_REQUEST_LIMITS,
  type PageRequestLimits,
} from "../shared/request-budget";
import type {
  SourceSegment,
  TranslationFailure,
  TranslationRequest,
  TranslationResult,
} from "../shared/types";
import { clearTranslations } from "./cleanup";
import { extractSegments, type ExtractedSegment } from "./extractor";
import {
  applyAppearanceToTranslations,
  getContentState,
  renderTranslation,
  setTranslationPending,
  setTranslationsVisible,
} from "./renderer";
import type { ContentRuntimeState } from "./state";

export interface ContentControllerDependencies {
  document: Document;
  state: ContentRuntimeState;
  requestTranslations(
    request: TranslationRequest,
    operationId: string,
  ): Promise<unknown>;
  cancelTranslation?: (operationId: string) => unknown;
  loadContentSettings?: () => Promise<ContentSettings>;
  browserUiLanguage?: () => string | undefined;
  pageRequestLimits?: PageRequestLimits;
}

export interface ContentController {
  handleMessage(message: unknown): Promise<ContentResponse>;
}

interface ActiveTranslation {
  readonly generation: number;
  readonly operationId: string;
  readonly promise: Promise<ContentResponse>;
}

interface ActiveManualRetry {
  readonly operationId: string;
  readonly promise: Promise<void>;
}

interface ActiveSettingsRefresh {
  readonly generation: number;
  readonly promise: Promise<boolean>;
}

function defaultContentSettings(): ContentSettings {
  return {
    retry: { ...DEFAULT_RETRY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
    uiLanguage: "system",
  };
}

function success(
  dependencies: ContentControllerDependencies,
  message: MessageDescriptor,
): ContentResponse {
  return {
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    state: getContentState(dependencies.document, dependencies.state),
    message,
  };
}

function resultFailure(
  segment: SourceSegment,
  code: "MISSING_RESULT" | "DUPLICATE_RESULT",
): TranslationFailure {
  return {
    id: segment.id,
    status: "failure",
    error: createError(code),
  };
}

function failureFromError(
  segment: SourceSegment,
  error: StructuredError,
): TranslationFailure {
  return { id: segment.id, status: "failure", error };
}

function mapResultsById(
  segments: readonly SourceSegment[],
  results: readonly TranslationResult[],
): ReadonlyMap<string, TranslationResult> {
  const counts = new Map<string, number>();
  const providerResults = new Map<string, TranslationResult>();

  for (const result of results) {
    counts.set(result.id, (counts.get(result.id) ?? 0) + 1);
    providerResults.set(result.id, result);
  }

  return new Map(
    segments.map((segment) => {
      if ((counts.get(segment.id) ?? 0) > 1) {
        return [segment.id, resultFailure(segment, "DUPLICATE_RESULT")];
      }

      return [
        segment.id,
        providerResults.get(segment.id) ??
          resultFailure(segment, "MISSING_RESULT"),
      ];
    }),
  );
}

export function createContentController(
  dependencies: ContentControllerDependencies,
): ContentController {
  const pageRequestLimits =
    dependencies.pageRequestLimits ?? DEFAULT_PAGE_REQUEST_LIMITS;
  let operationGeneration = 0;
  let activeTranslation: ActiveTranslation | undefined;
  let activeSettingsRefresh: ActiveSettingsRefresh | undefined;
  let settings = defaultContentSettings();
  let locale: UiLocale = resolveUiLocale(
    settings.uiLanguage,
    dependencies.browserUiLanguage?.(),
  );
  const manualRetries = new Map<string, ActiveManualRetry>();
  const issuedOperationIds = new Set<string>();

  const nextOperationId = (): string => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = createOperationId();
      if (!issuedOperationIds.has(candidate)) {
        issuedOperationIds.add(candidate);
        return candidate;
      }
    }
    throw new Error("Could not allocate a unique translation operation ID.");
  };

  const applyCurrentSettings = (): void => {
    let browserLanguage: string | undefined;
    try {
      browserLanguage = dependencies.browserUiLanguage?.();
    } catch {
      browserLanguage = undefined;
    }
    locale = resolveUiLocale(settings.uiLanguage, browserLanguage);
    applyAppearanceToTranslations(
      dependencies.document,
      dependencies.state,
      settings.appearance,
    );
  };

  const refreshSettings = (generation: number): true | Promise<boolean> => {
    if (dependencies.loadContentSettings === undefined) {
      if (generation === operationGeneration) {
        applyCurrentSettings();
        return true;
      }
      return Promise.resolve(false);
    }

    if (activeSettingsRefresh?.generation === generation) {
      return activeSettingsRefresh.promise;
    }

    let load: Promise<ContentSettings>;
    try {
      load = dependencies.loadContentSettings();
    } catch {
      load = Promise.reject(new Error("Content settings load failed."));
    }
    const promise = load.then(
      (loaded) => {
        if (generation !== operationGeneration) {
          return false;
        }
        settings = loaded;
        applyCurrentSettings();
        return true;
      },
      () => {
        if (generation !== operationGeneration) {
          return false;
        }
        settings = defaultContentSettings();
        applyCurrentSettings();
        return true;
      },
    );
    const refresh: ActiveSettingsRefresh = { generation, promise };
    activeSettingsRefresh = refresh;
    void promise.then(() => {
      if (activeSettingsRefresh === refresh) {
        activeSettingsRefresh = undefined;
      }
    });
    return promise;
  };

  const cancelled = (): ContentResponse =>
    success(dependencies, createMessage("content.cancelled"));

  const cancelOperation = (operationId: string): void => {
    if (dependencies.cancelTranslation === undefined) {
      return;
    }
    try {
      const pending = dependencies.cancelTranslation(operationId);
      void Promise.resolve(pending).catch(() => undefined);
    } catch {
      // Clear remains local and synchronous even if cancellation IPC fails.
    }
  };

  const renderResult = (
    extracted: ExtractedSegment,
    result: TranslationResult,
    visible: boolean,
    allowManualRetry: boolean,
  ): HTMLElement =>
    renderTranslation(extracted, result, dependencies.state, visible, {
      appearance: settings.appearance,
      locale,
      ...(result.status === "failure" && allowManualRetry
        ? {
            onRetry: () => {
              startManualRetry(extracted);
            },
          }
        : {}),
    });

  const performManualRetry = async (
    extracted: ExtractedSegment,
    generation: number,
    operationId: string,
  ): Promise<void> => {
    const existing = dependencies.state.translationsBySource.get(
      extracted.element,
    );
    if (
      existing === undefined ||
      !dependencies.state.translations.has(existing)
    ) {
      return;
    }
    setTranslationPending(existing, dependencies.state, true, locale);

    const settingsRefresh = refreshSettings(generation);
    const settingsReady =
      settingsRefresh === true ? true : await settingsRefresh;
    if (!settingsReady || generation !== operationGeneration) {
      return;
    }
    setTranslationPending(existing, dependencies.state, true, locale);

    let result: TranslationResult;
    let allowManualRetry = false;
    try {
      const request: TranslationRequest = {
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        segments: [extracted.segment],
      };
      const rawResponse = await dependencies.requestTranslations(
        request,
        operationId,
      );
      if (generation !== operationGeneration) {
        return;
      }
      const parsed = parseTranslationResponse(rawResponse);
      if (!parsed.ok) {
        result = failureFromError(extracted.segment, parsed.error);
      } else if (!parsed.value.ok) {
        result = failureFromError(extracted.segment, parsed.value.error);
      } else {
        result =
          mapResultsById(request.segments, parsed.value.results).get(
            extracted.segment.id,
          ) ?? resultFailure(extracted.segment, "MISSING_RESULT");
        allowManualRetry = result.status === "failure";
      }
    } catch (error) {
      if (generation !== operationGeneration) {
        return;
      }
      result = failureFromError(
        extracted.segment,
        sanitizeError(error, "TRANSLATION_FAILED"),
      );
    }

    if (generation !== operationGeneration) {
      return;
    }
    const visible = getContentState(
      dependencies.document,
      dependencies.state,
    ).visible;
    renderResult(extracted, result, visible, allowManualRetry);
  };

  function startManualRetry(extracted: ExtractedSegment): void {
    const id = extracted.segment.id;
    if (manualRetries.has(id)) {
      return;
    }
    const generation = operationGeneration;
    const operationId = nextOperationId();
    const promise = performManualRetry(extracted, generation, operationId);
    const operation: ActiveManualRetry = { operationId, promise };
    manualRetries.set(id, operation);
    void promise.then(
      () => {
        if (manualRetries.get(id) === operation) {
          manualRetries.delete(id);
        }
      },
      () => {
        if (manualRetries.get(id) === operation) {
          manualRetries.delete(id);
        }
      },
    );
  }

  const performTranslate = async (
    generation: number,
    operationId: string,
  ): Promise<ContentResponse> => {
    try {
      const allExtracted = extractSegments(
        dependencies.document,
        dependencies.state,
      );
      if (allExtracted.length === 0) {
        const state = getContentState(
          dependencies.document,
          dependencies.state,
        );
        return success(
          dependencies,
          createMessage(
            state.translationCount > 0
              ? "content.alreadyUpToDate"
              : "content.noEligible",
          ),
        );
      }

      const selectedCount = countPageRequestPrefix(
        allExtracted.map(({ segment }) => segment),
        pageRequestLimits,
      );
      const extracted = allExtracted.slice(0, selectedCount);
      const omitted = allExtracted.length - extracted.length;
      if (extracted.length === 0) {
        return success(
          dependencies,
          omitted > 0
            ? createMessage("content.noFitOmitted", { omitted })
            : createMessage("content.noFit"),
        );
      }

      const request: TranslationRequest = {
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        segments: extracted.map(({ segment }) => segment),
      };
      const rawResponse = await dependencies.requestTranslations(
        request,
        operationId,
      );
      if (generation !== operationGeneration) {
        return cancelled();
      }

      const parsed = parseTranslationResponse(rawResponse);
      if (!parsed.ok) {
        return createErrorResponse(parsed.error);
      }
      if (!parsed.value.ok) {
        return parsed.value;
      }

      const byId = mapResultsById(request.segments, parsed.value.results);
      const shouldBeVisible = getContentState(
        dependencies.document,
        dependencies.state,
      ).visible;
      for (const item of extracted) {
        const result = byId.get(item.segment.id);
        if (result !== undefined) {
          renderResult(
            item,
            result,
            shouldBeVisible,
            result.status === "failure",
          );
        }
      }

      const succeeded =
        request.segments.length -
        Array.from(byId.values()).filter(
          (result) => result.status === "failure",
        ).length;
      const failed = request.segments.length - succeeded;
      return success(
        dependencies,
        omitted > 0
          ? createMessage("content.translationSummaryOmitted", {
              succeeded,
              failed,
              omitted,
            })
          : createMessage("content.translationSummary", { succeeded, failed }),
      );
    } catch (error) {
      if (generation !== operationGeneration) {
        return cancelled();
      }
      return createErrorResponse(sanitizeError(error, "TRANSLATION_FAILED"));
    }
  };

  const translate = (): Promise<ContentResponse> => {
    if (activeTranslation?.generation === operationGeneration) {
      return activeTranslation.promise;
    }

    const generation = operationGeneration;
    const operationId = nextOperationId();
    const settingsRefresh = refreshSettings(generation);
    const promise =
      settingsRefresh === true
        ? performTranslate(generation, operationId)
        : settingsRefresh.then((settingsReady) =>
            settingsReady && generation === operationGeneration
              ? performTranslate(generation, operationId)
              : cancelled(),
          );
    const operation: ActiveTranslation = {
      generation,
      operationId,
      promise,
    };
    activeTranslation = operation;
    void promise.then(
      () => {
        if (activeTranslation === operation) {
          activeTranslation = undefined;
        }
      },
      () => {
        if (activeTranslation === operation) {
          activeTranslation = undefined;
        }
      },
    );
    return promise;
  };

  const toggle = (): ContentResponse => {
    const state = getContentState(dependencies.document, dependencies.state);
    if (state.translationCount === 0) {
      return success(dependencies, createMessage("content.toggleEmpty"));
    }

    const visible = !state.visible;
    setTranslationsVisible(dependencies.document, dependencies.state, visible);
    return success(
      dependencies,
      createMessage(visible ? "content.shown" : "content.hidden"),
    );
  };

  const clear = (): ContentResponse => {
    const operationIds = new Set<string>();
    if (activeTranslation !== undefined) {
      operationIds.add(activeTranslation.operationId);
    }
    for (const retry of manualRetries.values()) {
      operationIds.add(retry.operationId);
    }

    operationGeneration += 1;
    activeTranslation = undefined;
    activeSettingsRefresh = undefined;
    manualRetries.clear();
    for (const operationId of operationIds) {
      cancelOperation(operationId);
    }
    const removed = clearTranslations(
      dependencies.document,
      dependencies.state,
    );

    let message: MessageDescriptor;
    if (removed === 0) {
      message = createMessage(
        operationIds.size === 0
          ? "content.clearEmpty"
          : "content.clearEmptyCancelled",
      );
    } else {
      message =
        operationIds.size === 0
          ? createMessage("content.cleared", { count: removed })
          : createMessage("content.clearedAndCancelled", { count: removed });
    }
    return success(dependencies, message);
  };

  return {
    handleMessage(message: unknown): Promise<ContentResponse> {
      const parsed = parseContentCommand(message);
      if (!parsed.ok) {
        return Promise.resolve(createErrorResponse(parsed.error));
      }

      switch (parsed.value.command) {
        case "translate":
          return translate();
        case "toggle":
          return Promise.resolve(toggle());
        case "clear":
          return Promise.resolve(clear());
      }
    },
  };
}
