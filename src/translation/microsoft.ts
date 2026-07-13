import type { MicrosoftSettings } from "../settings/types";
import { UserFacingError } from "../shared/errors";
import type { TranslationRequest, TranslationResult } from "../shared/types";
import { fetchProviderJson, type HttpProviderDependencies } from "./http";
import type {
  TranslationProvider,
  TranslationProviderContext,
} from "./provider";

export interface ConfiguredMicrosoftSettings extends MicrosoftSettings {
  apiKey: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class MicrosoftTranslationProvider implements TranslationProvider {
  readonly name = "Microsoft Translator";

  readonly #settings: ConfiguredMicrosoftSettings;
  readonly #dependencies: HttpProviderDependencies;

  constructor(
    settings: ConfiguredMicrosoftSettings,
    dependencies: HttpProviderDependencies = {},
  ) {
    this.#settings = settings;
    this.#dependencies = dependencies;
  }

  async translate(
    request: TranslationRequest,
    context?: TranslationProviderContext,
  ): Promise<readonly TranslationResult[]> {
    const targetLanguage: string = request.targetLanguage;
    if (targetLanguage !== "zh-CN") {
      throw new UserFacingError("VALIDATION_ERROR");
    }
    const microsoftTargetLanguage = "zh-Hans";
    const url = new URL(
      `${this.#settings.endpoint.replace(/\/+$/u, "")}/translate`,
    );
    url.searchParams.set("api-version", "3.0");
    url.searchParams.set("to", microsoftTargetLanguage);

    const payload = await fetchProviderJson(
      this.name,
      url.toString(),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Ocp-Apim-Subscription-Key": this.#settings.apiKey,
          "Ocp-Apim-Subscription-Region": this.#settings.region,
        },
        body: JSON.stringify(
          request.segments.map((segment) => ({ Text: segment.text })),
        ),
      },
      this.#dependencies,
      context?.signal,
    );

    if (!Array.isArray(payload) || payload.length !== request.segments.length) {
      throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
    }

    const results: unknown[] = payload;
    return request.segments.map((segment, index) => {
      const result: unknown = results[index];
      if (!isRecord(result) || !Array.isArray(result["translations"])) {
        throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
      }
      const translations: unknown[] = result["translations"];
      const translation: unknown = translations[0];
      if (
        !isRecord(translation) ||
        typeof translation["text"] !== "string" ||
        translation["text"].trim() === "" ||
        (translation["to"] !== undefined &&
          translation["to"] !== microsoftTargetLanguage)
      ) {
        throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
      }
      return {
        id: segment.id,
        status: "success",
        translatedText: translation["text"],
      };
    });
  }
}
