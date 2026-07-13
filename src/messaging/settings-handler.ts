import { sanitizeError, UserFacingError } from "../shared/errors";
import type {
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../settings/types";
import type { TranslationProviderResolver } from "../translation/provider";
import { createErrorResponse, PROTOCOL_VERSION } from "./protocol";
import {
  parseSettingsRequest,
  type SettingsResponse,
} from "./settings-protocol";

export interface SettingsRepository {
  loadPublic(): Promise<PublicProviderSettings>;
  save(
    draft: ProviderSettingsDraft,
    replacements: {
      openaiApiKey?: string;
      microsoftApiKey?: string;
    },
  ): Promise<unknown>;
  clearApiKey(provider: "openai" | "microsoft"): Promise<void>;
}

export function createSettingsMessageHandler(
  repository: SettingsRepository,
  resolveProvider: TranslationProviderResolver,
): (message: unknown) => Promise<SettingsResponse> {
  const success = async (message: string): Promise<SettingsResponse> => ({
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    settings: await repository.loadPublic(),
    message,
  });

  return async (message) => {
    const parsed = parseSettingsRequest(message);
    if (!parsed.ok) {
      return createErrorResponse(parsed.error);
    }

    try {
      switch (parsed.value.command) {
        case "get":
          return await success("Provider settings loaded.");
        case "save":
          await repository.save(parsed.value.draft, parsed.value.apiKeys);
          return await success("Provider settings saved.");
        case "clear-api-key":
          await repository.clearApiKey(parsed.value.provider);
          return await success(
            parsed.value.provider === "openai"
              ? "OpenAI-compatible API key cleared."
              : "Microsoft Translator API key cleared.",
          );
        case "test-connection": {
          const provider = await resolveProvider();
          const results = await provider.translate({
            sourceLanguage: "auto",
            targetLanguage: "zh-CN",
            segments: [
              {
                id: "paralume-connection-test",
                text: "Paralume connection test.",
              },
            ],
          });
          if (
            results.length !== 1 ||
            results[0]?.id !== "paralume-connection-test" ||
            results[0].status !== "success"
          ) {
            throw new UserFacingError("MALFORMED_PROVIDER_OUTPUT");
          }
          return await success("Provider connection test succeeded.");
        }
      }
    } catch (error) {
      return createErrorResponse(sanitizeError(error, "INTERNAL_ERROR"));
    }
  };
}
