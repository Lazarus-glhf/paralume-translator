import {
  createClearApiKeyMessage,
  createGetSettingsMessage,
  createSaveSettingsMessage,
  createTestConnectionMessage,
  parseSettingsResponse,
} from "../messaging/settings-protocol";
import type { MessageDescriptor } from "../localization";
import {
  requestProviderOriginPermission,
  removeStaleProviderOriginPermission,
  type ProviderPermissionsApi,
} from "../settings/permissions";
import type {
  ApiKeyReplacements,
  ProviderSettings,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../settings/types";
import { validateProviderSettingsDraft } from "../settings/validation";
import { UserFacingError } from "../shared/errors";

export interface OptionsRuntimeApi {
  sendMessage(message: unknown): Promise<unknown>;
}

export interface OptionsActionResult {
  settings: PublicProviderSettings;
  message: MessageDescriptor;
}

export interface OptionsClient {
  load: () => Promise<PublicProviderSettings>;
  save: (
    draft: ProviderSettingsDraft,
    replacements: ApiKeyReplacements,
  ) => Promise<OptionsActionResult>;
  clearApiKey: (
    provider: "openai" | "microsoft",
  ) => Promise<OptionsActionResult>;
  testConnection: () => Promise<OptionsActionResult>;
}

function publicAsStored(settings: PublicProviderSettings): ProviderSettings {
  return {
    version: settings.version,
    provider: settings.provider,
    openai: {
      baseUrl: settings.openai.baseUrl,
      model: settings.openai.model,
      protocol: settings.openai.protocol,
      reasoningEffort: settings.openai.reasoningEffort,
    },
    microsoft: {
      endpoint: settings.microsoft.endpoint,
      region: settings.microsoft.region,
    },
    retry: { ...settings.retry },
    appearance: { ...settings.appearance },
    uiLanguage: settings.uiLanguage,
  };
}

export function createOptionsClient(
  runtime: OptionsRuntimeApi,
  permissions: ProviderPermissionsApi,
): OptionsClient {
  let currentSettings: PublicProviderSettings | undefined;

  const send = async (message: unknown): Promise<OptionsActionResult> => {
    const parsed = parseSettingsResponse(await runtime.sendMessage(message));
    if (!parsed.ok) {
      throw new UserFacingError(parsed.error.code);
    }
    if (!parsed.value.ok) {
      throw new UserFacingError(parsed.value.error.code);
    }
    currentSettings = parsed.value.settings;
    return { settings: parsed.value.settings, message: parsed.value.message };
  };

  return {
    async load() {
      return (await send(createGetSettingsMessage())).settings;
    },
    async save(draft, replacements) {
      const validated = validateProviderSettingsDraft(draft);
      const permissionRequest = requestProviderOriginPermission(
        validated,
        permissions,
      );
      await permissionRequest;
      const previous = publicAsStored(
        (await send(createGetSettingsMessage())).settings,
      );
      const normalizedDraft: ProviderSettingsDraft = {
        provider: validated.provider,
        openai: {
          baseUrl: validated.openai.baseUrl,
          model: validated.openai.model,
          protocol: validated.openai.protocol,
          reasoningEffort: validated.openai.reasoningEffort,
        },
        microsoft: {
          endpoint: validated.microsoft.endpoint,
          region: validated.microsoft.region,
        },
        retry: { ...validated.retry },
        appearance: { ...validated.appearance },
        uiLanguage: validated.uiLanguage,
      };
      const result = await send(
        createSaveSettingsMessage(normalizedDraft, replacements),
      );
      const removal = await removeStaleProviderOriginPermission(
        previous,
        publicAsStored(result.settings),
        permissions,
      );
      if (removal === "failed") {
        return {
          settings: result.settings,
          message: { id: "settings.permissionRemovalFailed" },
        };
      }
      return result;
    },
    clearApiKey(provider) {
      return send(createClearApiKeyMessage(provider));
    },
    async testConnection() {
      if (currentSettings === undefined) {
        throw new UserFacingError("VALIDATION_ERROR");
      }
      const permissionRequest = requestProviderOriginPermission(
        publicAsStored(currentSettings),
        permissions,
      );
      await permissionRequest;
      return send(createTestConnectionMessage());
    },
  };
}

export function createBrowserOptionsClient(): OptionsClient {
  return createOptionsClient(browser.runtime, browser.permissions);
}
