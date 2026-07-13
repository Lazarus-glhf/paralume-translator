import type { TranslationRequest, TranslationResult } from "../shared/types";
import { UserFacingError } from "../shared/errors";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStructuredTranslations(
  serialized: string,
  request: TranslationRequest,
): readonly TranslationResult[] {
  let payload: unknown;
  try {
    payload = JSON.parse(serialized) as unknown;
  } catch {
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }

  if (
    !isRecord(payload) ||
    Object.keys(payload).length !== 1 ||
    !Array.isArray(payload["translations"])
  ) {
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }

  const translations = payload["translations"];
  if (translations.length !== request.segments.length) {
    throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
  }

  const byId = new Map<string, string>();
  for (const value of translations) {
    if (
      !isRecord(value) ||
      Object.keys(value).length !== 2 ||
      typeof value["id"] !== "string" ||
      typeof value["translatedText"] !== "string" ||
      value["translatedText"].trim() === ""
    ) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    if (byId.has(value["id"])) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    byId.set(value["id"], value["translatedText"]);
  }

  const requestedIds = new Set(request.segments.map((segment) => segment.id));
  for (const id of byId.keys()) {
    if (!requestedIds.has(id)) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
  }

  return request.segments.map((segment) => {
    const translatedText = byId.get(segment.id);
    if (translatedText === undefined) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }
    return { id: segment.id, status: "success", translatedText };
  });
}

export function createTranslationJsonSchema(segmentCount: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["translations"],
    properties: {
      translations: {
        type: "array",
        minItems: segmentCount,
        maxItems: segmentCount,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "translatedText"],
          properties: {
            id: { type: "string" },
            translatedText: { type: "string" },
          },
        },
      },
    },
  } as const;
}
