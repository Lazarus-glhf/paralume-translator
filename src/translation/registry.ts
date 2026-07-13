import {
  hasProviderOriginPermission,
  type ProviderPermissionsApi,
} from "../settings/permissions";
import type { ProviderSettings } from "../settings/types";
import type { HttpProviderDependencies } from "./http";
import { MicrosoftTranslationProvider } from "./microsoft";
import { MockTranslationProvider } from "./mock";
import { OpenAiTranslationProvider } from "./openai";
import type {
  TranslationProvider,
  TranslationProviderResolver,
} from "./provider";
import { UserFacingError } from "../shared/errors";

export interface ProviderSettingsReader {
  load(): Promise<ProviderSettings>;
}

export function createConfiguredProvider(
  settings: ProviderSettings,
  dependencies: HttpProviderDependencies = {},
): TranslationProvider {
  switch (settings.provider) {
    case "mock":
      return new MockTranslationProvider();
    case "openai":
      if (settings.openai.apiKey === undefined) {
        throw new UserFacingError("API_KEY_UNCONFIGURED");
      }
      return new OpenAiTranslationProvider(
        { ...settings.openai, apiKey: settings.openai.apiKey },
        dependencies,
      );
    case "microsoft":
      if (settings.microsoft.apiKey === undefined) {
        throw new UserFacingError("API_KEY_UNCONFIGURED");
      }
      return new MicrosoftTranslationProvider(
        { ...settings.microsoft, apiKey: settings.microsoft.apiKey },
        dependencies,
      );
  }
}

export function createSettingsBackedProviderResolver(
  repository: ProviderSettingsReader,
  permissions: ProviderPermissionsApi,
  dependencies: HttpProviderDependencies = {},
): TranslationProviderResolver {
  return async () => {
    const settings = await repository.load();
    if (!(await hasProviderOriginPermission(settings, permissions))) {
      throw new UserFacingError("PERMISSION_MISSING");
    }
    return createConfiguredProvider(settings, dependencies);
  };
}
