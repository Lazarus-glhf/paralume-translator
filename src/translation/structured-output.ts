import type { TranslationRequest, TranslationResult } from "../shared/types";
import { UserFacingError } from "../shared/errors";

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
    return { id: segment.id, status: "success", translatedText };
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
    return { id: segment.id, status: "success", translatedText };
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
