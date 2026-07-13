import { createError, UserFacingError, type ErrorCode } from "../shared/errors";
import type { TranslationRequest, TranslationResult } from "../shared/types";
import type { TranslationProvider } from "./provider";

export interface MockTranslationProviderOptions {
  failSegmentIds?: ReadonlySet<string>;
}

const TRANSIENT_FIXTURE_PATTERN =
  /^\[\[PARALUME_MOCK_TRANSIENT:([0-9]):(RATE_LIMITED|REQUEST_TIMEOUT|NETWORK_ERROR|SERVER_UNAVAILABLE)\]\]\s*/u;
const transientAttempts = new Map<string, number>();

interface TransientFixture {
  failures: number;
  code: ErrorCode;
  text: string;
  attempt: number;
}

function parseTransientFixture(text: string): TransientFixture | undefined {
  const match = TRANSIENT_FIXTURE_PATTERN.exec(text);
  if (match === null) {
    return undefined;
  }
  const failures = Number(match[1]);
  const code = match[2] as ErrorCode;
  const attempt = (transientAttempts.get(text) ?? 0) + 1;
  transientAttempts.set(text, attempt);
  return {
    failures,
    code,
    text: text.slice(match[0].length),
    attempt,
  };
}

export function resetMockTransientFailuresForTests(): void {
  transientAttempts.clear();
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
    const fixtures = new Map(
      request.segments.map((segment) => [
        segment.id,
        parseTransientFixture(segment.text),
      ]),
    );
    const pendingFailure = Array.from(fixtures.values()).find(
      (fixture) => fixture !== undefined && fixture.attempt <= fixture.failures,
    );
    if (pendingFailure !== undefined) {
      return Promise.reject(new UserFacingError(pendingFailure.code));
    }

    return Promise.resolve(
      request.segments.map((segment): TranslationResult => {
        if (this.#failSegmentIds.has(segment.id)) {
          return {
            id: segment.id,
            status: "failure",
            error: createError("TRANSLATION_FAILED"),
          };
        }

        const fixture = fixtures.get(segment.id);
        return {
          id: segment.id,
          status: "success",
          translatedText:
            fixture === undefined
              ? `【Mock ${request.targetLanguage}】${segment.text}`
              : `【Mock ${request.targetLanguage} attempt ${String(fixture.attempt)}】${fixture.text}`,
        };
      }),
    );
  }
}
