import type { TranslationRequest, TranslationResult } from "../shared/types";
import { createError, UserFacingError } from "../shared/errors";

const LONG_UNTRANSLATED_TEXT_LENGTH = 80;
const MIN_WORDS_FOR_UNTRANSLATED_CHECK = 8;
const MIN_LOWERCASE_WORDS_FOR_CASED_TEXT = 4;

function normalizedTranslationText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function isUntranslatedOutput(
  sourceText: string,
  translatedText: string,
  targetLanguage: string,
): boolean {
  if (!targetLanguage.toLowerCase().startsWith("zh")) return false;
  const normalizedSource = normalizedTranslationText(sourceText);
  if (
    normalizedSource.length < LONG_UNTRANSLATED_TEXT_LENGTH ||
    normalizedSource !== normalizedTranslationText(translatedText)
  ) {
    return false;
  }
  const words = normalizedSource.match(/[\p{L}]+(?:['’-][\p{L}]+)*/gu) ?? [];
  const cjkCharacters = normalizedSource.match(/[\p{Script=Han}]/gu);
  if (
    words.length < MIN_WORDS_FOR_UNTRANSLATED_CHECK ||
    (cjkCharacters?.length ?? 0) >= 4
  ) {
    return false;
  }
  const casedWords = words.filter(
    (word) => word.toLowerCase() !== word.toUpperCase(),
  );
  if (casedWords.length === 0) return true;
  const lowercaseWords = casedWords.filter((word) => {
    const firstCharacter = Array.from(word)[0];
    return (
      firstCharacter !== undefined &&
      word.startsWith(firstCharacter.toLowerCase())
    );
  });
  return lowercaseWords.length >= MIN_LOWERCASE_WORDS_FOR_CASED_TEXT;
}

export function createValidatedTranslationResult(
  id: string,
  sourceText: string,
  translatedText: string,
  targetLanguage: string,
): TranslationResult {
  return isUntranslatedOutput(sourceText, translatedText, targetLanguage)
    ? { id, status: "failure", error: createError("UNTRANSLATED_OUTPUT") }
    : { id, status: "success", translatedText };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface CompactTranslationIds {
  readonly compactByOriginal: ReadonlyMap<string, string>;
  readonly originalByCompact: ReadonlyMap<string, string>;
}

export function createCompactTranslationIds(
  request: TranslationRequest,
): CompactTranslationIds {
  const pairs = request.segments.map(
    (segment, index) => [segment.id, index.toString(36)] as const,
  );
  return {
    compactByOriginal: new Map(pairs),
    originalByCompact: new Map(
      pairs.map(([original, compact]) => [compact, original] as const),
    ),
  };
}

function parseLegacyStructuredTranslations(
  payload: Record<string, unknown>,
  request: TranslationRequest,
): readonly TranslationResult[] | undefined {
  if (
    Object.keys(payload).length !== 1 ||
    !Array.isArray(payload["translations"]) ||
    payload["translations"].length !== request.segments.length
  ) {
    return undefined;
  }

  const requestedIds = new Set(request.segments.map((segment) => segment.id));
  const byId = new Map<string, string>();
  for (const value of payload["translations"]) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      typeof value["id"] !== "string" ||
      typeof value["translatedText"] !== "string" ||
      value["translatedText"].trim() === "" ||
      !requestedIds.has(value["id"]) ||
      byId.has(value["id"])
    ) {
      return undefined;
    }
    byId.set(value["id"], value["translatedText"]);
  }

  return request.segments.map((segment) => {
    const translatedText = byId.get(segment.id);
    if (translatedText === undefined) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    return createValidatedTranslationResult(
      segment.id,
      segment.text,
      translatedText,
      request.targetLanguage,
    );
  });
}

export function parseCompactStructuredTranslations(
  serialized: string,
  request: TranslationRequest,
  ids: CompactTranslationIds,
): readonly TranslationResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(serialized) as unknown;
  } catch {
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }

  if (!isRecord(payload)) {
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }
  if (!Array.isArray(payload["t"])) {
    const legacy = parseLegacyStructuredTranslations(payload, request);
    if (legacy !== undefined) {
      return legacy;
    }
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }
  if (
    Object.keys(payload).length !== 1 ||
    payload["t"].length !== request.segments.length
  ) {
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }

  const byOriginalId = new Map<string, string>();
  for (const value of payload["t"]) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      typeof value["i"] !== "string" ||
      typeof value["v"] !== "string" ||
      value["v"].trim() === ""
    ) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    const originalId = ids.originalByCompact.get(value["i"]);
    if (originalId === undefined || byOriginalId.has(originalId)) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    byOriginalId.set(originalId, value["v"]);
  }

  return request.segments.map((segment) => {
    const translatedText = byOriginalId.get(segment.id);
    if (translatedText === undefined) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    return createValidatedTranslationResult(
      segment.id,
      segment.text,
      translatedText,
      request.targetLanguage,
    );
  });
}

export function createCompactTranslationJsonSchema(segmentCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["t"],
    properties: {
      t: {
        type: "array",
        minItems: segmentCount,
        maxItems: segmentCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["i", "v"],
          properties: {
            i: { type: "string" },
            v: { type: "string" },
          },
        },
      },
    },
  } as const;
}
