import { createBackgroundTranslationMessage } from "../messaging/protocol";
import type { TranslationRequest } from "../shared/types";
import { createContentController, type ContentController } from "./controller";
import { createContentRuntimeState, type ContentRuntimeState } from "./state";

const CONTENT_RUNTIME_KEY = "__PARALUME_CONTENT_RUNTIME_V1__";

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
}

interface InstalledContentRuntime {
  readonly version: 1;
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
    value.version === 1 &&
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
  const controller = createContentController({
    document: dependencies.document,
    state,
    requestTranslations(request: TranslationRequest) {
      return dependencies.runtime.sendMessage(
        createBackgroundTranslationMessage(request),
      );
    },
  });

  dependencies.runtime.onMessage.addListener((message) =>
    controller.handleMessage(message),
  );
  dependencies.globalObject[CONTENT_RUNTIME_KEY] = {
    version: 1,
    controller,
    state,
  } satisfies InstalledContentRuntime;
  return true;
}
