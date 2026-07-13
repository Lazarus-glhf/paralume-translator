import { useEffect, useState } from "react";

import {
  formatDescriptor,
  formatMessage,
  resolveUiLocale,
  translateError,
  type MessageDescriptor,
} from "../../src/localization";
import type {
  ContentCommand,
  ContentResponse,
} from "../../src/messaging/protocol";
import {
  loadPopupContentSettings,
  runPageCommand,
} from "../../src/popup/client";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_RETRY_SETTINGS,
} from "../../src/settings/repository";
import type { ContentSettings } from "../../src/settings/types";
import { sanitizeError, type ErrorCode } from "../../src/shared/errors";
import type { ContentState } from "../../src/shared/types";

export interface AppProps {
  runCommand?: (command: ContentCommand) => Promise<ContentResponse>;
  loadContentSettings?: () => Promise<ContentSettings>;
  getBrowserUiLanguage?: () => string | undefined;
}

const INITIAL_STATE: ContentState = {
  translationCount: 0,
  failureCount: 0,
  visible: true,
};

function defaults(): ContentSettings {
  return {
    retry: { ...DEFAULT_RETRY_SETTINGS },
    appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
    uiLanguage: "system",
  };
}

function browserUiLanguage(): string | undefined {
  try {
    return browser.i18n.getUILanguage();
  } catch {
    return undefined;
  }
}

function readBrowserUiLanguage(
  getter: () => string | undefined,
): string | undefined {
  try {
    return getter();
  } catch {
    return undefined;
  }
}

export function App({
  runCommand = runPageCommand,
  loadContentSettings = loadPopupContentSettings,
  getBrowserUiLanguage = browserUiLanguage,
}: AppProps) {
  const [preferences, setPreferences] = useState(defaults);
  const [busy, setBusy] = useState(false);
  const [pageState, setPageState] = useState(INITIAL_STATE);
  const [status, setStatus] = useState<MessageDescriptor>({
    id: "popup.ready",
  });
  const [error, setError] = useState<ErrorCode | null>(null);
  const locale = resolveUiLocale(
    preferences.uiLanguage,
    readBrowserUiLanguage(getBrowserUiLanguage),
  );

  useEffect(() => {
    let active = true;
    void loadContentSettings().then(
      (loaded) => {
        if (active) {
          setPreferences(loaded);
        }
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, [loadContentSettings]);

  const handleAction = async (command: ContentCommand) => {
    setBusy(true);
    setError(null);
    setStatus({
      id:
        command === "translate"
          ? "popup.translating"
          : command === "toggle"
            ? "popup.toggling"
            : "popup.clearing",
    });

    try {
      const response = await runCommand(command);
      if (response.ok) {
        setPageState(response.state);
        setStatus(response.message);
      } else {
        setError(response.error.code);
      }
    } catch (caught) {
      setError(sanitizeError(caught).code);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main
      className="popup"
      aria-labelledby="popup-title"
      aria-busy={busy}
      lang={locale}
    >
      <p className="eyebrow">{formatMessage(locale, "popup.title")}</p>
      <h1 id="popup-title">Paralume</h1>
      <p className="summary">{formatMessage(locale, "popup.description")}</p>

      <div
        className="actions"
        aria-label={formatMessage(locale, "popup.title")}
      >
        <button
          type="button"
          data-action="translate"
          disabled={busy}
          onClick={() => void handleAction("translate")}
        >
          {formatMessage(locale, "popup.translate")}
        </button>
        <button
          type="button"
          className="secondary"
          data-action="toggle"
          disabled={busy}
          onClick={() => void handleAction("toggle")}
        >
          {formatMessage(locale, "popup.toggle")}
        </button>
        <button
          type="button"
          className="secondary danger"
          data-action="clear"
          disabled={busy}
          onClick={() => void handleAction("clear")}
        >
          {formatMessage(locale, "popup.clear")}
        </button>
      </div>

      <div className="page-state" data-testid="page-state">
        <span>
          {formatMessage(locale, "popup.translated", {
            count: pageState.translationCount,
          })}
        </span>
        <span>
          {formatMessage(locale, "popup.failures", {
            count: pageState.failureCount,
          })}
        </span>
        <span>
          {formatMessage(
            locale,
            pageState.visible ? "popup.visible" : "popup.hidden",
          )}
        </span>
      </div>

      <p className="status" role="status">
        {formatDescriptor(locale, status)}
      </p>
      {error === null ? null : (
        <p className="error" role="alert">
          {translateError(locale, error)}
        </p>
      )}
    </main>
  );
}
