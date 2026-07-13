import {
  PROTOCOL_VERSION,
  createErrorResponse,
  type ContentResponse,
} from "../messaging/protocol";
import {
  parseContentCommand,
  parseTranslationResponse,
} from "../messaging/validation";
import { createError, sanitizeError } from "../shared/errors";
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
import { extractSegments } from "./extractor";
import {
  getContentState,
  renderTranslation,
  setTranslationsVisible,
} from "./renderer";
import type { ContentRuntimeState } from "./state";

export interface ContentControllerDependencies {
  document: Document;
  state: ContentRuntimeState;
  requestTranslations(request: TranslationRequest): Promise<unknown>;
  pageRequestLimits?: PageRequestLimits;
}

export interface ContentController {
  handleMessage(message: unknown): Promise<ContentResponse>;
}

interface ActiveTranslation {
  readonly generation: number;
  readonly promise: Promise<ContentResponse>;
}

function success(
  dependencies: ContentControllerDependencies,
  message: string,
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

function describeOmittedBlocks(omitted: number): string {
  return omitted === 0
    ? ""
    : ` ${String(omitted)} additional readable block${omitted === 1 ? " was" : "s were"} skipped by the per-page request limit.`;
}

export function createContentController(
  dependencies: ContentControllerDependencies,
): ContentController {
  const pageRequestLimits =
    dependencies.pageRequestLimits ?? DEFAULT_PAGE_REQUEST_LIMITS;
  let operationGeneration = 0;
  let activeTranslation: ActiveTranslation | undefined;

  const cancelled = (): ContentResponse =>
    success(
      dependencies,
      "Translation was cancelled because translations were cleared.",
    );

  const performTranslate = async (
    generation: number,
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
          state.translationCount > 0
            ? "Translations are already up to date."
            : "No eligible readable blocks were found on this page.",
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
          `No readable blocks fit within the per-page request limit.${describeOmittedBlocks(omitted)}`,
        );
      }

      const request: TranslationRequest = {
        sourceLanguage: "auto",
        targetLanguage: "zh-CN",
        segments: extracted.map(({ segment }) => segment),
      };
      const rawResponse = await dependencies.requestTranslations(request);
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
          renderTranslation(item, result, dependencies.state, shouldBeVisible);
        }
      }

      const state = getContentState(dependencies.document, dependencies.state);
      const succeeded =
        request.segments.length -
        Array.from(byId.values()).filter(
          (result) => result.status === "failure",
        ).length;
      const requestFailures = request.segments.length - succeeded;
      const resultMessage =
        requestFailures === 0
          ? `Translated ${String(succeeded)} readable block${succeeded === 1 ? "" : "s"}.`
          : `Translated ${String(succeeded)} block${succeeded === 1 ? "" : "s"}; ${String(requestFailures)} unavailable.`;

      return {
        protocolVersion: PROTOCOL_VERSION,
        ok: true,
        state,
        message: `${resultMessage}${describeOmittedBlocks(omitted)}`,
      };
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
    const promise = performTranslate(generation);
    const operation: ActiveTranslation = { generation, promise };
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
      return success(
        dependencies,
        "There are no translations to toggle. Pending translations remain visible.",
      );
    }

    const visible = !state.visible;
    setTranslationsVisible(dependencies.document, dependencies.state, visible);
    return success(
      dependencies,
      visible ? "Translations shown." : "Translations hidden.",
    );
  };

  const clear = (): ContentResponse => {
    operationGeneration += 1;
    activeTranslation = undefined;
    const removed = clearTranslations(
      dependencies.document,
      dependencies.state,
    );
    return success(
      dependencies,
      removed === 0
        ? "There are no translations to clear. Pending translation work was cancelled."
        : `Cleared ${String(removed)} translation${removed === 1 ? "" : "s"}.`,
    );
  };

  return {
    async handleMessage(message: unknown): Promise<ContentResponse> {
      const parsed = parseContentCommand(message);
      if (!parsed.ok) {
        return createErrorResponse(parsed.error);
      }

      switch (parsed.value.command) {
        case "translate":
          return translate();
        case "toggle":
          return toggle();
        case "clear":
          return clear();
      }
    },
  };
}
