import { resolveUiLocale, type UiLocale } from "../localization";
import {
  createBackgroundCancelTranslationMessage,
  createBackgroundTranslationMessage,
  createContentCommand,
} from "../messaging/protocol";
import {
  createGetContentSettingsMessage,
  createOpenOptionsMessage,
  parseContentSettingsResponse,
} from "../messaging/settings-protocol";
import {
  parseCancelTranslationResponse,
  parseContentCommand,
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
  floatingMenu?: boolean;
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
  let updateLocale: (locale: UiLocale) => void = () => undefined;

  // Full page recount: re-extracts every candidate (computed styles, layout).
  // Only run it at phase boundaries, never once per rendered segment.
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
  // Page total captured when a translating phase starts. Rendering moves
  // segments from "remaining" to success/failure without changing the total,
  // so per-segment updates only need the cheap rendered-translation counts.
  let translatingPageTotal: number | undefined;
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
      // Same resolver as the controller, Popup, and Options so the menu never
      // disagrees with page retry/failure text (e.g. zh-TW resolves to "en").
      updateLocale(
        resolveUiLocale(
          parsed.value.contentSettings.uiLanguage,
          dependencies.getBrowserUiLanguage?.(),
        ),
      );
      return parsed.value.contentSettings;
    },
    onProgress(progress) {
      if (progress.phase !== "translating") {
        translatingPageTotal = undefined;
        updateProgress(getPageProgress(progress.phase));
      } else if (
        translatingPageTotal === undefined ||
        progress.completed === 0
      ) {
        // Operation start (translate / retry-failed always report 0 first).
        const pageProgress = getPageProgress("translating");
        translatingPageTotal = pageProgress.total;
        updateProgress(pageProgress);
      } else {
        const contentState = getContentState(dependencies.document, state);
        const completed =
          contentState.translationCount - contentState.failureCount;
        updateProgress({
          phase: "translating",
          completed,
          total: Math.max(translatingPageTotal, completed),
        });
      }
      updateFailureCount(
        getContentState(dependencies.document, state).failureCount,
      );
    },
    ...(dependencies.getBrowserUiLanguage === undefined
      ? {}
      : { browserUiLanguage: dependencies.getBrowserUiLanguage }),
  });

  const menu =
    dependencies.floatingMenu === false
      ? undefined
      : installFloatingMenu(
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
            async openSettings() {
              await dependencies.runtime.sendMessage(
                createOpenOptionsMessage(),
              );
            },
          },
        );
  if (menu !== undefined) {
    state.ownedNodes.add(menu.host);
  }
  updateProgress = (progress) => {
    menu?.setProgress(progress);
  };
  updateFailureCount = (count) => {
    menu?.setFailureCount(count);
  };
  updateLocale = (locale) => {
    menu?.setLocale(locale);
  };

  menu?.setProgress(getPageProgress("idle"));
  void dependencies.runtime
    .sendMessage(createGetContentSettingsMessage())
    .then((rawSettings) => {
      const parsed = parseContentSettingsResponse(rawSettings);
      if (!parsed.ok || !parsed.value.ok) return;
      // Same resolver as the controller, Popup, and Options so the menu never
      // disagrees with page retry/failure text (e.g. zh-TW resolves to "en").
      updateLocale(
        resolveUiLocale(
          parsed.value.contentSettings.uiLanguage,
          dependencies.getBrowserUiLanguage?.(),
        ),
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
    const command = parseContentCommand(message);
    // Share action ordering across both entry points. Polling must not erase
    // the last action result or supersede an in-flight action's feedback.
    if (
      menu !== undefined &&
      command.ok &&
      command.value.command !== "status"
    ) {
      return menu.runCommand(command.value.command);
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
