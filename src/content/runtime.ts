import {
  createBackgroundCancelTranslationMessage,
  createBackgroundTranslationMessage,
  createContentCommand,
} from "../messaging/protocol";
import {
  createGetContentSettingsMessage,
  parseContentSettingsResponse,
} from "../messaging/settings-protocol";
import { parseCancelTranslationResponse } from "../messaging/validation";
import { UserFacingError } from "../shared/errors";
import type { TranslationRequest } from "../shared/types";
import {
  createContentController,
  type ContentController,
  type TranslationProgress,
} from "./controller";
import { installFloatingMenu } from "./floating-menu";
import { createContentRuntimeState, type ContentRuntimeState } from "./state";

const CONTENT_RUNTIME_KEY = "__PARALUME_CONTENT_RUNTIME_V2__";

export interface ContentRuntime {
  onMessage: {
    addListener: (listener: (message: unknown) => Promise<unknown>) => void;
  };
  sendMessage: (message: unknown) => Promise<unknown>;
}

export interface ContentRuntimeDependencies {
  document: Document;
  globalObject: Record<string, unknown>;
  runtime: ContentRuntime;
  getBrowserUiLanguage?: () => string | undefined;
}

interface InstalledContentRuntime {
  readonly version: 2;
  readonly controller: ContentController;
  readonly state: ContentRuntimeState;
}

function isInstalledContentRuntime(
  value: unknown,
): value is InstalledContentRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 2 &&
    "controller" in value &&
    "state" in value
  );
}

export function installContentRuntime(
  dependencies: ContentRuntimeDependencies,
): boolean {
  if (
    isInstalledContentRuntime(dependencies.globalObject[CONTENT_RUNTIME_KEY])
  ) {
    return false;
  }

  const state = createContentRuntimeState();
  let updateProgress: (progress: TranslationProgress) => void = () => undefined;
  let updateLocale: (locale: "en" | "zh-CN") => void = () => undefined;
  const controller = createContentController({
    document: dependencies.document,
    state,
    requestTranslations(request: TranslationRequest, operationId: string) {
      return dependencies.runtime.sendMessage(
        createBackgroundTranslationMessage(request, operationId),
      );
    },
    async cancelTranslation(operationId: string) {
      const parsed = parseCancelTranslationResponse(
        await dependencies.runtime.sendMessage(
          createBackgroundCancelTranslationMessage(operationId),
        ),
      );
      if (!parsed.ok) {
        throw new UserFacingError(parsed.error.code);
      }
      if (!parsed.value.ok) {
        throw new UserFacingError(parsed.value.error.code);
      }
    },
    async loadContentSettings() {
      const parsed = parseContentSettingsResponse(
        await dependencies.runtime.sendMessage(
          createGetContentSettingsMessage(),
        ),
      );
      if (!parsed.ok) {
        throw new UserFacingError(parsed.error.code);
      }
      if (!parsed.value.ok) {
        throw new UserFacingError(parsed.value.error.code);
      }
      const requested = parsed.value.contentSettings.uiLanguage;
      const browserLanguage = dependencies.getBrowserUiLanguage?.();
      updateLocale(
        requested === "zh-CN" ||
          (requested === "system" && browserLanguage?.startsWith("zh"))
          ? "zh-CN"
          : "en",
      );
      return parsed.value.contentSettings;
    },
    onProgress(progress) {
      updateProgress(progress);
    },
    ...(dependencies.getBrowserUiLanguage === undefined
      ? {}
      : { browserUiLanguage: dependencies.getBrowserUiLanguage }),
  });

  const menu = installFloatingMenu(
    dependencies.document,
    (command) => controller.handleMessage(createContentCommand(command)),
    "en",
  );
  state.ownedNodes.add(menu.host);
  updateProgress = (progress) => {
    menu.setProgress(progress);
  };
  updateLocale = (locale) => {
    menu.setLocale(locale);
  };

  dependencies.runtime.onMessage.addListener((message) =>
    controller.handleMessage(message),
  );
  dependencies.globalObject[CONTENT_RUNTIME_KEY] = {
    version: 2,
    controller,
    state,
  } satisfies InstalledContentRuntime;
  return true;
}
