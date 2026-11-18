import { createError, sanitizeError, UserFacingError } from "../shared/errors";
import { createMessage, type MessageId } from "../localization";
import type { SaveSettingsResult } from "../settings/repository";
import {
  siteKeyFromUrl,
  type SitePreferenceStore,
} from "../settings/site-preferences";
import type {
  ContentSettings,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../settings/types";
import type {
  TranslationProvider,
  TranslationProviderResolver,
  TranslationStreamProvider,
} from "../translation/provider";
import { createErrorResponse, PROTOCOL_VERSION } from "./protocol";
import { getSenderUrl } from "./sender";
import {
  parseSettingsRequest,
  type AnySettingsResponse,
  type SettingsRequest,
} from "./settings-protocol";

type MaybeStreamingProvider = TranslationProvider &
  Partial<TranslationStreamProvider>;

export interface SettingsRepository {
  loadPublic(): Promise<PublicProviderSettings>;
  loadContent(): Promise<ContentSettings>;
  save(
    draft: ProviderSettingsDraft,
    replacements: {
      openaiApiKey?: string;
      microsoftApiKey?: string;
    },
  ): Promise<Pick<SaveSettingsResult, "removedApiKeys">>;
  clearApiKey(provider: "openai" | "microsoft"): Promise<void>;
}

export interface SettingsHandlerDependencies {
  readonly openOptionsPage?: () => Promise<void>;
  // Must return true only for this extension's own pages. Without it every
  // privileged command is rejected.
  readonly isExtensionPageSender?: (sender: unknown) => boolean;
  readonly sitePreferences?: SitePreferenceStore;
}

// Commands that read provider configuration, write settings or keys, or spend
// provider quota. Content scripts run in every web page and must not reach
// them; they only need get-content, open-options and their own site state.
const EXTENSION_PAGE_COMMANDS: ReadonlySet<SettingsRequest["command"]> =
  new Set(["get", "save", "clear-api-key", "test-connection"]);

export function createSettingsMessageHandler(
  repository: SettingsRepository,
  resolveProvider: TranslationProviderResolver,
  dependencies: SettingsHandlerDependencies = {},
): (
  message: unknown,
  context?: { readonly sender: unknown },
) => Promise<AnySettingsResponse> {
  const success = async (message: MessageId): Promise<AnySettingsResponse> => ({
    protocolVersion: PROTOCOL_VERSION,
    ok: true,
    settings: await repository.loadPublic(),
    message: createMessage(message),
  });

  const senderSite = (sender: unknown): string => {
    const site = siteKeyFromUrl(getSenderUrl(sender));
    if (site === undefined) {
      throw new UserFacingError("INVALID_MESSAGE");
    }
    return site;
  };

  const requireSitePreferences = (): SitePreferenceStore => {
    if (dependencies.sitePreferences === undefined) {
      throw new UserFacingError("INTERNAL_ERROR");
    }
    return dependencies.sitePreferences;
  };

  return async (message, context) => {
    const parsed = parseSettingsRequest(message);
    if (!parsed.ok) {
      return createErrorResponse(parsed.error);
    }
    const sender = context?.sender;
    if (
      EXTENSION_PAGE_COMMANDS.has(parsed.value.command) &&
      dependencies.isExtensionPageSender?.(sender) !== true
    ) {
      return createErrorResponse(createError("INVALID_MESSAGE"));
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
        case "save": {
          const saved = await repository.save(
            parsed.value.draft,
            parsed.value.apiKeys,
          );
          return await success(
            saved.removedApiKeys.length > 0
              ? "settings.savedApiKeyRemoved"
              : "settings.saved",
          );
        }
        case "clear-api-key":
          await repository.clearApiKey(parsed.value.provider);
          return await success(
            parsed.value.provider === "openai"
              ? "settings.openAiKeyCleared"
              : "settings.microsoftKeyCleared",
          );
        case "test-connection": {
          const provider: MaybeStreamingProvider = await resolveProvider();
          // Page translation streams whenever the provider can, so the test
          // takes the same path; otherwise an endpoint that cannot stream
          // would pass here and then fail on every page.
          const translate =
            provider.streamTranslate?.bind(provider) ??
            provider.translate.bind(provider);
          const results = await translate({
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
        case "open-options":
          // Lets the page floating control reach Options; carries no data.
          if (dependencies.openOptionsPage === undefined) {
            throw new UserFacingError("INTERNAL_ERROR");
          }
          await dependencies.openOptionsPage();
          return { protocolVersion: PROTOCOL_VERSION, ok: true };
        // The site always comes from the browser-provided sender URL, never
        // from the message, so a frame can only read or disable its own site.
        case "get-site-state": {
          const site = senderSite(sender);
          return {
            protocolVersion: PROTOCOL_VERSION,
            ok: true,
            siteDisabled: await requireSitePreferences().isDisabled(site),
          };
        }
        case "disable-site": {
          const site = senderSite(sender);
          await requireSitePreferences().disable(site);
          return { protocolVersion: PROTOCOL_VERSION, ok: true };
        }
      }
    } catch (error) {
      return createErrorResponse(sanitizeError(error, "INTERNAL_ERROR"));
    }
  };
}
