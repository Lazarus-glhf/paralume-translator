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
  isConfigurationErrorCode,
  isRecoverableProviderErrorCode,
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
import { DEFAULT_BATCH_LIMITS, type BatchLimits } from "../translation/batcher";
import { clearTranslations, invalidateSourceTranslation } from "./cleanup";
import { getCurrentSourceText } from "./text";
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
  progressiveBatchLimits?: BatchLimits;
  onProgress?: (progress: TranslationProgress) => void;
}

export interface TranslationProgress {
  phase: "idle" | "translating" | "complete" | "error";
  completed: number;
  total: number;
}

export interface ContentController {
  handleMessage(message: unknown): Promise<ContentResponse>;
  handleStreamingResult(operationId: string, result: TranslationResult): void;
}

interface ActiveTranslation {
  readonly generation: number;
  readonly operationIds: Set<string>;
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
  const progressiveBatchLimits =
    dependencies.progressiveBatchLimits ?? DEFAULT_BATCH_LIMITS;
  let operationGeneration = 0;
  let activeTranslation: ActiveTranslation | undefined;
  let activeBulkRetry: ActiveTranslation | undefined;
  let activeSettingsRefresh: ActiveSettingsRefresh | undefined;
  let settings = defaultContentSettings();
  let locale: UiLocale = resolveUiLocale(
    settings.uiLanguage,
    dependencies.browserUiLanguage?.(),
  );
  const manualRetries = new Map<string, ActiveManualRetry>();
  const workTokens = new Set<symbol>();
  const workGenerations = new Map<symbol, number>();
  const cancellationReasons = new Map<number, "clear" | "stop">();
  const issuedOperationIds = new Set<string>();
  const streamingOperations = new Map<
    string,
    { generation: number; items: Map<string, ExtractedSegment> }
  >();
  let liveProgress:
    | { generation: number; total: number; completedIds: Set<string> }
    | undefined;

  const beginWork = (): symbol => {
    const token = Symbol("translation-work");
    workTokens.add(token);
    workGenerations.set(token, operationGeneration);
    dependencies.state.working = true;
    return token;
  };

  const endWork = (token: symbol): void => {
    const generation = workGenerations.get(token);
    workGenerations.delete(token);
    workTokens.delete(token);
    dependencies.state.working = workTokens.size > 0;
    if (
      generation !== undefined &&
      !Array.from(workGenerations.values()).includes(generation)
    ) {
      cancellationReasons.delete(generation);
    }
  };

  const refreshResponseState = (response: ContentResponse): ContentResponse =>
    response.ok
      ? {
          ...response,
          state: getContentState(dependencies.document, dependencies.state),
        }
      : response;

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

  const cancelled = (generation: number): ContentResponse =>
    success(
      dependencies,
      createMessage(
        cancellationReasons.get(generation) === "stop"
          ? "content.cancelledByStop"
          : "content.cancelled",
      ),
    );

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

  const isSourceCurrent = (extracted: ExtractedSegment): boolean =>
    extracted.element.isConnected &&
    dependencies.document.contains(extracted.element) &&
    getCurrentSourceText(extracted.element, dependencies.state) ===
      extracted.segment.text;

  // A failure rendered for source text that has since changed (or a source
  // that left the document) can never be resolved by retrying the old text.
  // Drop it, as the next extraction would, instead of leaving a Retry control
  // stuck in its pending state.
  const discardStaleTranslation = (
    element: HTMLElement,
    translation: HTMLElement,
  ): void => {
    if (dependencies.state.translationsBySource.get(element) === translation) {
      invalidateSourceTranslation(element, dependencies.state);
    }
  };

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
    if (!isSourceCurrent(extracted)) {
      discardStaleTranslation(extracted.element, existing);
      return;
    }
    setTranslationPending(existing, dependencies.state, true, locale);

    const settingsRefresh = refreshSettings(generation);
    const settingsReady =
      settingsRefresh === true ? true : await settingsRefresh;
    if (!settingsReady || generation !== operationGeneration) {
      return;
    }
    if (!isSourceCurrent(extracted)) {
      discardStaleTranslation(extracted.element, existing);
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
        // A transient whole-request failure keeps the segment retryable.
        allowManualRetry = isRecoverableProviderErrorCode(
          parsed.value.error.code,
        );
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
      // The request never produced a provider verdict (for example the
      // extension messaging channel was briefly unavailable), so trying the
      // same segment again stays possible.
      allowManualRetry = true;
    }

    if (generation !== operationGeneration) {
      return;
    }
    if (!isSourceCurrent(extracted)) {
      discardStaleTranslation(extracted.element, existing);
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
    const wasWorking = dependencies.state.working;
    const workToken = beginWork();
    if (!wasWorking) {
      dependencies.onProgress?.({
        phase: "translating",
        completed: 0,
        total: 1,
      });
    }
    const promise = performManualRetry(extracted, generation, operationId);
    const operation: ActiveManualRetry = { operationId, promise };
    manualRetries.set(id, operation);
    void promise.then(
      () => {
        endWork(workToken);
        if (manualRetries.get(id) === operation) {
          manualRetries.delete(id);
        }
        if (generation === operationGeneration) {
          dependencies.onProgress?.({
            phase: dependencies.state.working ? "translating" : "complete",
            completed: 1,
            total: 1,
          });
        }
      },
      () => {
        endWork(workToken);
        if (manualRetries.get(id) === operation) {
          manualRetries.delete(id);
        }
        if (generation === operationGeneration) {
          dependencies.onProgress?.({
            phase: dependencies.state.working ? "translating" : "error",
            completed: 0,
            total: 1,
          });
        }
      },
    );
  }

  const performTranslate = async (
    generation: number,
    operationIds: Set<string>,
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
      const pageOmitted = allExtracted.length - extracted.length;
      if (extracted.length === 0) {
        return success(
          dependencies,
          pageOmitted > 0
            ? createMessage("content.noFitOmitted", { omitted: pageOmitted })
            : createMessage("content.noFit"),
        );
      }

      const batches: ExtractedSegment[][] = [];
      let currentBatch: ExtractedSegment[] = [];
      let currentCharacters = 0;
      const flushBatch = (): void => {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
          currentCharacters = 0;
        }
      };
      for (const item of extracted) {
        if (
          currentBatch.length >= progressiveBatchLimits.maxSegments ||
          currentCharacters + item.segment.text.length >
            progressiveBatchLimits.maxCharacters
        ) {
          flushBatch();
        }
        currentBatch.push(item);
        currentCharacters += item.segment.text.length;
      }
      flushBatch();
      liveProgress = {
        generation,
        total: extracted.length,
        completedIds: new Set(),
      };
      dependencies.onProgress?.({
        phase: "translating",
        completed: 0,
        total: extracted.length,
      });

      let succeeded = 0;
      let failed = 0;
      let stale = 0;
      let firstError: ContentResponse | undefined;
      // Set by a configuration failure; later batches would fail identically,
      // so no further batches are dispatched once it is set.
      let configurationError: ContentResponse | undefined;
      let nextBatchIndex = 0;
      const reportRendered = (segmentId: string): void => {
        if (liveProgress?.generation === generation) {
          liveProgress.completedIds.add(segmentId);
        }
        dependencies.onProgress?.({
          phase: "translating",
          completed:
            liveProgress?.generation === generation
              ? liveProgress.completedIds.size
              : succeeded + failed + stale,
          total:
            liveProgress?.generation === generation
              ? liveProgress.total
              : extracted.length,
        });
      };
      const handleBatchError = (
        batch: readonly ExtractedSegment[],
        error: StructuredError,
      ): void => {
        const response = createErrorResponse(error);
        if (isConfigurationErrorCode(error.code)) {
          configurationError ??= response;
          return;
        }
        firstError ??= response;
        if (!isRecoverableProviderErrorCode(error.code)) {
          return;
        }
        // Transient whole-batch failure: render each unfinished segment as a
        // failure so manual Retry and "Retry all failed" can reach it.
        const visible = getContentState(
          dependencies.document,
          dependencies.state,
        ).visible;
        for (const item of batch) {
          if (
            (liveProgress?.generation === generation &&
              liveProgress.completedIds.has(item.segment.id)) ||
            !item.element.isConnected ||
            !dependencies.document.contains(item.element) ||
            getCurrentSourceText(item.element, dependencies.state) !==
              item.segment.text
          ) {
            continue;
          }
          const existing = dependencies.state.translationsBySource.get(
            item.element,
          );
          if (
            existing !== undefined &&
            dependencies.state.translationStatuses.get(existing) === "success"
          ) {
            continue;
          }
          renderResult(
            item,
            failureFromError(item.segment, error),
            visible,
            true,
          );
          failed += 1;
          reportRendered(item.segment.id);
        }
      };
      let reservedOperationId = operationIds.values().next().value;
      const takeOperationId = (): string => {
        if (reservedOperationId !== undefined) {
          const operationId = reservedOperationId;
          reservedOperationId = undefined;
          return operationId;
        }
        const operationId = nextOperationId();
        operationIds.add(operationId);
        return operationId;
      };
      const worker = async (): Promise<void> => {
        for (;;) {
          const batch = batches[nextBatchIndex];
          nextBatchIndex += 1;
          if (
            batch === undefined ||
            generation !== operationGeneration ||
            configurationError !== undefined
          ) {
            return;
          }

          const operationId = takeOperationId();
          streamingOperations.set(operationId, {
            generation,
            items: new Map(batch.map((item) => [item.segment.id, item])),
          });
          const request: TranslationRequest = {
            sourceLanguage: "auto",
            targetLanguage: "zh-CN",
            segments: batch.map(({ segment }) => segment),
          };
          let rawResponse: unknown;
          try {
            rawResponse = await dependencies.requestTranslations(
              request,
              operationId,
            );
          } catch (error) {
            if (generation !== operationGeneration) {
              return;
            }
            handleBatchError(batch, sanitizeError(error, "TRANSLATION_FAILED"));
            continue;
          } finally {
            operationIds.delete(operationId);
            streamingOperations.delete(operationId);
          }
          if (generation !== operationGeneration) {
            return;
          }

          const parsed = parseTranslationResponse(rawResponse);
          if (!parsed.ok) {
            handleBatchError(batch, parsed.error);
            continue;
          }
          if (!parsed.value.ok) {
            handleBatchError(batch, parsed.value.error);
            continue;
          }

          const byId = mapResultsById(request.segments, parsed.value.results);
          const shouldBeVisible = getContentState(
            dependencies.document,
            dependencies.state,
          ).visible;
          for (const item of batch) {
            if (
              !item.element.isConnected ||
              !dependencies.document.contains(item.element) ||
              getCurrentSourceText(item.element, dependencies.state) !==
                item.segment.text
            ) {
              stale += 1;
              continue;
            }
            const result = byId.get(item.segment.id);
            if (result === undefined) {
              continue;
            }
            const existingTranslation =
              dependencies.state.translationsBySource.get(item.element);
            if (
              result.status === "failure" &&
              existingTranslation !== undefined &&
              dependencies.state.translationStatuses.get(
                existingTranslation,
              ) === "success"
            ) {
              succeeded += 1;
              continue;
            }
            renderResult(
              item,
              result,
              shouldBeVisible,
              result.status === "failure",
            );
            if (result.status === "failure") {
              failed += 1;
            } else {
              succeeded += 1;
            }
            reportRendered(item.segment.id);
          }
        }
      };

      await Promise.all(
        Array.from(
          {
            length: Math.min(
              progressiveBatchLimits.concurrency,
              batches.length,
            ),
          },
          () => worker(),
        ),
      );
      if (generation !== operationGeneration) {
        return cancelled(generation);
      }
      // Segments rendered from streamed results of a batch that later failed
      // are in the live count but not in the per-batch tallies; the terminal
      // progress must not drop below what was already shown.
      const finished = Math.max(
        succeeded + failed + stale,
        liveProgress.generation === generation
          ? liveProgress.completedIds.size
          : 0,
      );
      const terminalError = configurationError ?? firstError;
      if (terminalError !== undefined) {
        dependencies.onProgress?.({
          phase: "error",
          completed: finished,
          total: extracted.length,
        });
        return terminalError;
      }

      const omitted = pageOmitted + stale;
      dependencies.onProgress?.({
        phase: "complete",
        completed: finished,
        total: extracted.length,
      });
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
        return cancelled(generation);
      }
      return createErrorResponse(sanitizeError(error, "TRANSLATION_FAILED"));
    }
  };

  const translate = (): Promise<ContentResponse> => {
    if (activeTranslation?.generation === operationGeneration) {
      return activeTranslation.promise;
    }

    const generation = operationGeneration;
    const operationIds = new Set<string>([nextOperationId()]);
    const workToken = beginWork();
    const settingsRefresh = refreshSettings(generation);
    const workPromise =
      settingsRefresh === true
        ? performTranslate(generation, operationIds)
        : settingsRefresh.then((settingsReady) =>
            settingsReady && generation === operationGeneration
              ? performTranslate(generation, operationIds)
              : cancelled(generation),
          );
    const promise = workPromise.then(
      (response) => {
        endWork(workToken);
        return refreshResponseState(response);
      },
      (error: unknown) => {
        endWork(workToken);
        throw error;
      },
    );
    const operation: ActiveTranslation = {
      generation,
      operationIds,
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

  const retryFailed = (): Promise<ContentResponse> => {
    if (activeBulkRetry?.generation === operationGeneration) {
      return activeBulkRetry.promise;
    }
    const failed: (ExtractedSegment & { readonly translation: HTMLElement })[] =
      [];
    for (const translation of Array.from(dependencies.state.translations)) {
      if (
        dependencies.state.translationStatuses.get(translation) !== "failure"
      ) {
        continue;
      }
      const element = dependencies.state.sourcesByTranslation.get(translation);
      const marker = element && dependencies.state.sourceMarkers.get(element);
      if (element === undefined || marker === undefined) {
        continue;
      }
      if (
        !isSourceCurrent({
          element,
          segment: { id: marker.segmentId, text: marker.sourceText },
        })
      ) {
        discardStaleTranslation(element, translation);
        continue;
      }
      failed.push({
        element,
        translation,
        segment: { id: marker.segmentId, text: marker.sourceText },
      });
    }
    if (failed.length === 0) {
      return Promise.resolve(
        success(dependencies, createMessage("content.retryFailedEmpty")),
      );
    }

    const generation = operationGeneration;
    const operationId = nextOperationId();
    const operationIds = new Set([operationId]);
    const workToken = beginWork();
    for (const item of failed) {
      setTranslationPending(item.translation, dependencies.state, true, locale);
    }
    dependencies.onProgress?.({
      phase: "translating",
      completed: 0,
      total: failed.length,
    });
    const workPromise = dependencies
      .requestTranslations(
        {
          sourceLanguage: "auto",
          targetLanguage: "zh-CN",
          segments: failed.map((item) => item.segment),
        },
        operationId,
      )
      .then((rawResponse) => {
        if (generation !== operationGeneration) return cancelled(generation);
        const parsed = parseTranslationResponse(rawResponse);
        if (!parsed.ok) {
          for (const item of failed) {
            setTranslationPending(
              item.translation,
              dependencies.state,
              false,
              locale,
            );
          }
          dependencies.onProgress?.({
            phase: "error",
            completed: 0,
            total: failed.length,
          });
          return createErrorResponse(parsed.error);
        }
        if (!parsed.value.ok) {
          for (const item of failed) {
            setTranslationPending(
              item.translation,
              dependencies.state,
              false,
              locale,
            );
          }
          dependencies.onProgress?.({
            phase: "error",
            completed: 0,
            total: failed.length,
          });
          return createErrorResponse(parsed.value.error);
        }
        const byId = mapResultsById(
          failed.map((item) => item.segment),
          parsed.value.results,
        );
        const visible = getContentState(
          dependencies.document,
          dependencies.state,
        ).visible;
        for (const item of failed) {
          const result = byId.get(item.segment.id);
          const owned =
            dependencies.state.translationsBySource.get(item.element) ===
              item.translation &&
            dependencies.state.sourceMarkers.get(item.element)?.segmentId ===
              item.segment.id;
          if (owned && !isSourceCurrent(item)) {
            discardStaleTranslation(item.element, item.translation);
          } else if (
            result !== undefined &&
            owned &&
            dependencies.state.translationStatuses.get(item.translation) ===
              "failure"
          ) {
            renderResult(item, result, visible, result.status === "failure");
          } else {
            setTranslationPending(
              item.translation,
              dependencies.state,
              false,
              locale,
            );
          }
        }
        dependencies.onProgress?.({
          phase: "complete",
          completed: failed.length,
          total: failed.length,
        });
        return success(
          dependencies,
          createMessage("content.retryFailedComplete", {
            count: failed.length,
          }),
        );
      })
      .catch((error: unknown) => {
        // Clear already reset progress and removed these failures; a late
        // rejection from the cancelled request must not report an error.
        if (generation !== operationGeneration) return cancelled(generation);
        for (const item of failed) {
          setTranslationPending(
            item.translation,
            dependencies.state,
            false,
            locale,
          );
        }
        dependencies.onProgress?.({
          phase: "error",
          completed: 0,
          total: failed.length,
        });
        return createErrorResponse(sanitizeError(error, "TRANSLATION_FAILED"));
      })
      .finally(() => {
        operationIds.delete(operationId);
      });
    const promise = workPromise.then(
      (response) => {
        endWork(workToken);
        return refreshResponseState(response);
      },
      (error: unknown) => {
        endWork(workToken);
        throw error;
      },
    );
    const operation: ActiveTranslation = { generation, operationIds, promise };
    activeBulkRetry = operation;
    void promise.finally(() => {
      if (activeBulkRetry === operation) activeBulkRetry = undefined;
    });
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

  const cancelActiveWork = (reason: "clear" | "stop"): Set<string> => {
    const operationIds = new Set<string>();
    if (activeTranslation !== undefined) {
      for (const operationId of activeTranslation.operationIds) {
        operationIds.add(operationId);
      }
    }
    if (activeBulkRetry !== undefined) {
      for (const operationId of activeBulkRetry.operationIds) {
        operationIds.add(operationId);
      }
    }
    for (const retry of manualRetries.values()) {
      operationIds.add(retry.operationId);
    }

    const cancelledGeneration = operationGeneration;
    if (Array.from(workGenerations.values()).includes(cancelledGeneration)) {
      cancellationReasons.set(cancelledGeneration, reason);
    }
    operationGeneration += 1;
    streamingOperations.clear();
    activeTranslation = undefined;
    activeBulkRetry = undefined;
    activeSettingsRefresh = undefined;
    manualRetries.clear();
    workTokens.clear();
    dependencies.state.working = false;
    for (const operationId of operationIds) {
      cancelOperation(operationId);
    }
    return operationIds;
  };

  const stop = (): ContentResponse => {
    const wasWorking = dependencies.state.working;
    const operationIds = cancelActiveWork("stop");
    for (const translation of dependencies.state.translations) {
      setTranslationPending(translation, dependencies.state, false, locale);
    }
    dependencies.onProgress?.({ phase: "idle", completed: 0, total: 0 });
    const state = getContentState(dependencies.document, dependencies.state);
    return success(
      dependencies,
      createMessage(
        wasWorking || operationIds.size > 0
          ? "content.stopped"
          : "content.stopEmpty",
        wasWorking || operationIds.size > 0
          ? { count: state.translationCount }
          : undefined,
      ),
    );
  };

  const clear = (): ContentResponse => {
    const operationIds = cancelActiveWork("clear");
    dependencies.state.translationsVisible = true;
    const removed = clearTranslations(
      dependencies.document,
      dependencies.state,
    );
    dependencies.onProgress?.({ phase: "idle", completed: 0, total: 0 });

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
        case "status":
          return Promise.resolve(
            success(
              dependencies,
              createMessage(
                dependencies.state.working
                  ? "popup.translating"
                  : "popup.ready",
              ),
            ),
          );
        case "translate":
          return translate();
        case "retry-failed":
          return retryFailed();
        case "stop":
          return Promise.resolve(stop());
        case "toggle":
          return Promise.resolve(toggle());
        case "clear":
          return Promise.resolve(clear());
      }
    },
    handleStreamingResult(
      operationId: string,
      result: TranslationResult,
    ): void {
      const operation = streamingOperations.get(operationId);
      if (operation?.generation !== operationGeneration) {
        return;
      }
      const extracted = operation.items.get(result.id);
      if (
        extracted === undefined ||
        !extracted.element.isConnected ||
        getCurrentSourceText(extracted.element, dependencies.state) !==
          extracted.segment.text
      ) {
        return;
      }
      if (
        result.status === "failure" &&
        dependencies.state.translationsBySource.get(extracted.element) !==
          undefined
      ) {
        const existing = dependencies.state.translationsBySource.get(
          extracted.element,
        );
        if (
          existing !== undefined &&
          dependencies.state.translationStatuses.get(existing) === "success"
        ) {
          return;
        }
      }
      const visible = getContentState(
        dependencies.document,
        dependencies.state,
      ).visible;
      renderResult(extracted, result, visible, result.status === "failure");
      if (liveProgress?.generation === operationGeneration) {
        liveProgress.completedIds.add(result.id);
        dependencies.onProgress?.({
          phase: "translating",
          completed: liveProgress.completedIds.size,
          total: liveProgress.total,
        });
      }
    },
  };
}
