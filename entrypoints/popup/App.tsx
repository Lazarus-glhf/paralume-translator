import { useCallback, useEffect, useRef, useState } from "react";

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
  loadPopupSiteState,
  enablePopupSite,
  type PopupSiteState,
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
  loadSiteState?: () => Promise<PopupSiteState | undefined>;
  enableSite?: (site: string) => Promise<void>;
  autoStart?: boolean;
}

const INITIAL_STATE: ContentState = {
  translationCount: 0,
  failureCount: 0,
  visible: true,
  working: false,
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
  loadSiteState = loadPopupSiteState,
  enableSite = enablePopupSite,
  autoStart = true,
}: AppProps) {
  const [preferences, setPreferences] = useState(defaults);
  const [busy, setBusy] = useState(autoStart);
  const [pageState, setPageState] = useState(INITIAL_STATE);
  const [status, setStatus] = useState<MessageDescriptor>({
    id: "popup.ready",
  });
  const [error, setError] = useState<ErrorCode | null>(null);
  const [autoStarted, setAutoStarted] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<ContentCommand | null>(
    autoStart ? "status" : null,
  );
  const [siteState, setSiteState] = useState<PopupSiteState | undefined>();
  const [siteError, setSiteError] = useState<ErrorCode | null>(null);
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteStatus, setSiteStatus] = useState<MessageDescriptor | null>(null);
  const actionSequence = useRef(0);
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

  useEffect(() => {
    let active = true;
    void loadSiteState().then(
      (loaded) => {
        if (active) {
          setSiteState(loaded);
          setSiteError(null);
        }
      },
      (loadError: unknown) => {
        if (active) {
          setSiteError(sanitizeError(loadError).code);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [loadSiteState]);

  const handleAction = useCallback(
    async (command: ContentCommand) => {
      actionSequence.current += 1;
      const sequence = actionSequence.current;
      setBusy(true);
      setPendingCommand(command);
      setError(null);
      if (command === "translate") {
        setPageState((current) => ({ ...current, working: true }));
      }
      setStatus({
        id:
          command === "status"
            ? "popup.ready"
            : command === "translate"
              ? "popup.translating"
              : command === "stop"
                ? "popup.stopping"
                : command === "toggle"
                  ? "popup.toggling"
                  : "popup.clearing",
      });

      try {
        const response = await runCommand(command);
        if (sequence !== actionSequence.current) {
          return;
        }
        if (response.ok) {
          setPageState(response.state);
          setStatus(response.message);
        } else {
          if (command === "translate") {
            setPageState((current) => ({ ...current, working: false }));
          }
          setStatus({
            id: command === "stop" ? "popup.translating" : "popup.ready",
          });
          setError(response.error.code);
        }
      } catch (caught) {
        if (sequence !== actionSequence.current) {
          return;
        }
        if (command === "translate") {
          setPageState((current) => ({ ...current, working: false }));
        }
        setStatus({
          id: command === "stop" ? "popup.translating" : "popup.ready",
        });
        setError(sanitizeError(caught).code);
      } finally {
        if (sequence === actionSequence.current) {
          setBusy(false);
          setPendingCommand(null);
        }
      }
    },
    [runCommand],
  );

  useEffect(() => {
    if (autoStart && !autoStarted) {
      setAutoStarted(true);
      void handleAction("status");
    }
  }, [autoStart, autoStarted, handleAction]);

  useEffect(() => {
    if (!autoStart || busy) return;
    let active = true;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      const sequence = actionSequence.current;
      void runCommand("status")
        .then(
          (response) => {
            if (
              !active ||
              sequence !== actionSequence.current ||
              !response.ok
            ) {
              return;
            }
            setPageState(response.state);
            if (response.state.working !== pageState.working) {
              setStatus(response.message);
            }
          },
          () => undefined,
        )
        .finally(() => {
          pending = false;
        });
    }, 750);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [autoStart, busy, pageState.working, runCommand]);

  const restoreCurrentSite = async (): Promise<void> => {
    if (siteState?.disabled !== true) {
      return;
    }
    setSiteBusy(true);
    setSiteError(null);
    try {
      await enableSite(siteState.site);
      setSiteState({ ...siteState, disabled: false });
      setSiteStatus({ id: "popup.siteEnabled" });
    } catch (restoreError) {
      setSiteError(sanitizeError(restoreError).code);
    } finally {
      setSiteBusy(false);
    }
  };

  const working = pageState.working;

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
          data-action={working ? "stop" : "translate"}
          disabled={pendingCommand === "stop" || (!working && busy)}
          onClick={() => void handleAction(working ? "stop" : "translate")}
        >
          {formatMessage(locale, working ? "popup.stop" : "popup.translate")}
        </button>
        <button
          type="button"
          className="secondary"
          data-action="toggle"
          disabled={busy}
          onClick={() => void handleAction("toggle")}
        >
          {formatMessage(
            locale,
            pageState.visible
              ? "popup.hideTranslations"
              : "popup.showTranslations",
          )}
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

      {siteState?.disabled === true ? (
        <div className="site-disabled" data-testid="site-disabled">
          <p>
            {formatMessage(locale, "popup.siteDisabled", {
              site: siteState.site,
            })}
          </p>
          <button
            type="button"
            className="secondary"
            data-action="enable-site"
            disabled={siteBusy}
            onClick={() => void restoreCurrentSite()}
          >
            {formatMessage(
              locale,
              siteBusy ? "popup.enablingSite" : "popup.enableSite",
            )}
          </button>
        </div>
      ) : null}
      {siteStatus === null ? null : (
        <p className="status site-status" role="status">
          {formatDescriptor(locale, siteStatus)}
        </p>
      )}
      {siteError === null ? null : (
        <p className="error" role="alert">
          {translateError(locale, siteError)}
        </p>
      )}

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
