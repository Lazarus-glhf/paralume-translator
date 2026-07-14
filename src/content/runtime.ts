import {
  createBackgroundCancelTranslationMessage,
  createBackgroundTranslationMessage,
  createContentCommand,
} from "../messaging/protocol";
import {
  createGetContentSettingsMessage,
  parseContentSettingsResponse,
} from "../messaging/settings-protocol";
import {
  parseCancelTranslationResponse,
  parseTranslationResultMessage,
} from "../messaging/validation";
import { UserFacingError } from "../shared/errors";
import type { TranslationRequest } from "../shared/types";
import {
  createContentController,
  type ContentController,
  type TranslationProgress,
} from "./controller";
import { extractSegments } from "./extractor";
import { installFloatingMenu } from "./floating-menu";
import { getContentState } from "./renderer";
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
  siteLabel?: string;
  disableSite?: () => Promise<void>;
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
  let updateFailureCount: (count: number) => void = () => undefined;
  let updateLocale: (locale: "en" | "zh-CN") => void = () => undefined;
  const getPageProgress = (
    phase: TranslationProgress["phase"],
  ): TranslationProgress => {
    const contentState = getContentState(dependencies.document, state);
    const completed = contentState.translationCount - contentState.failureCount;
    const remaining =
      contentState.failureCount +
      extractSegments(dependencies.document, state).length;
    return { phase, completed, total: completed + remaining };
  };
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
      updateProgress(getPageProgress(progress.phase));
      updateFailureCount(
        getContentState(dependencies.document, state).failureCount,
      );
    },
    ...(dependencies.getBrowserUiLanguage === undefined
      ? {}
      : { browserUiLanguage: dependencies.getBrowserUiLanguage }),
  });

  const menu = installFloatingMenu(
    dependencies.document,
    (command) => controller.handleMessage(createContentCommand(command)),
    "en",
    {
      ...(dependencies.siteLabel === undefined
        ? {}
        : { siteLabel: dependencies.siteLabel }),
      ...(dependencies.disableSite === undefined
        ? {}
        : { disableSite: dependencies.disableSite }),
    },
  );
  state.ownedNodes.add(menu.host);
  updateProgress = (progress) => {
    menu.setProgress(progress);
  };
  updateFailureCount = (count) => {
    menu.setFailureCount(count);
  };
  updateLocale = (locale) => {
    menu.setLocale(locale);
  };
  menu.setProgress(getPageProgress("idle"));
  void dependencies.runtime
    .sendMessage(createGetContentSettingsMessage())
    .then((rawSettings) => {
      const parsed = parseContentSettingsResponse(rawSettings);
      if (!parsed.ok || !parsed.value.ok) return;
      const requested = parsed.value.contentSettings.uiLanguage;
      const browserLanguage = dependencies.getBrowserUiLanguage?.();
      updateLocale(
        requested === "zh-CN" ||
          (requested === "system" && browserLanguage?.startsWith("zh"))
          ? "zh-CN"
          : "en",
      );
    })
    .catch(() => undefined);

  dependencies.runtime.onMessage.addListener((message) => {
    const parsed = parseTranslationResultMessage(message);
    if (parsed.ok) {
      controller.handleStreamingResult(
        parsed.value.operationId,
        parsed.value.result,
      );
      return Promise.resolve(undefined);
    }
    return controller.handleMessage(message);
  });
  dependencies.globalObject[CONTENT_RUNTIME_KEY] = {
    version: 2,
    controller,
    state,
  } satisfies InstalledContentRuntime;
  return true;
}
