import { sanitizeError, UserFacingError } from "../shared/errors";
import { createMessage, type MessageId } from "../localization";
import type {
  ContentSettings,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../settings/types";
import type { TranslationProviderResolver } from "../translation/provider";
import { createErrorResponse, PROTOCOL_VERSION } from "./protocol";
import {
  parseSettingsRequest,
  type AnySettingsResponse,
} from "./settings-protocol";

export interface SettingsRepository {
  loadPublic(): Promise<PublicProviderSettings>;
  loadContent(): Promise<ContentSettings>;
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
): (message: unknown) => Promise<AnySettingsResponse> {
  const success = async (message: MessageId): Promise<AnySettingsResponse> => ({
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    settings: await repository.loadPublic(),
    message: createMessage(message),
  });

  return async (message) => {
    const parsed = parseSettingsRequest(message);
    if (!parsed.ok) {
      return createErrorResponse(parsed.error);
    }

    try {
      switch (parsed.value.command) {
        case "get":
          return await success("settings.loaded");
        case "get-content":
          return {
            protocolVersion: PROTOCOL_VERSION,
            ok: true,
            contentSettings: await repository.loadContent(),
          };
        case "save":
          await repository.save(parsed.value.draft, parsed.value.apiKeys);
          return await success("settings.saved");
        case "clear-api-key":
          await repository.clearApiKey(parsed.value.provider);
          return await success(
            parsed.value.provider === "openai"
              ? "settings.openAiKeyCleared"
              : "settings.microsoftKeyCleared",
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
          return await success("settings.testSucceeded");
        }
      }
    } catch (error) {
      return createErrorResponse(sanitizeError(error, "INTERNAL_ERROR"));
    }
  };
}
