import { createError } from "../shared/errors";
import type { TranslationRequest, TranslationResult } from "../shared/types";
import type { TranslationProvider } from "./provider";

export interface MockTranslationProviderOptions {
  failSegmentIds?: ReadonlySet<string>;
}

export class MockTranslationProvider implements TranslationProvider {
  readonly name = "Mock";

  readonly #failSegmentIds: ReadonlySet<string>;

  constructor(options: MockTranslationProviderOptions = {}) {
    this.#failSegmentIds = options.failSegmentIds ?? new Set();
  }

  translate(
    request: TranslationRequest,
  ): Promise<readonly TranslationResult[]> {
    return Promise.resolve(
      request.segments.map((segment): TranslationResult => {
        if (this.#failSegmentIds.has(segment.id)) {
          return {
            id: segment.id,
            status: "failure",
            error: createError("TRANSLATION_FAILED"),
          };
        }

        return {
          id: segment.id,
          status: "success",
          translatedText: `【Mock ${request.targetLanguage}】${segment.text}`,
        };
      }),
    );
  }
}
