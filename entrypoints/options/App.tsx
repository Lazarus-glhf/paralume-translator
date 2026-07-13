import { useEffect, useState } from "react";

import {
  formatDescriptor,
  formatMessage,
  resolveUiLocale,
  translateError,
  type MessageDescriptor,
} from "../../src/localization";
import {
  createBrowserOptionsClient,
  type OptionsActionResult,
  type OptionsClient,
} from "../../src/options/client";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_PROVIDER_SETTINGS,
} from "../../src/settings/repository";
import type {
  ApiKeyReplacements,
  AppearanceSettings,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../../src/settings/types";
import { sanitizeError, type ErrorCode } from "../../src/shared/errors";

export interface AppProps {
  client?: OptionsClient;
  getBrowserUiLanguage?: () => string | undefined;
}

function publicDefaults(): PublicProviderSettings {
  return {
    version: 2,
    provider: DEFAULT_PROVIDER_SETTINGS.provider,
    openai: {
      ...DEFAULT_PROVIDER_SETTINGS.openai,
      apiKeyConfigured: false,
    },
    microsoft: {
      ...DEFAULT_PROVIDER_SETTINGS.microsoft,
      apiKeyConfigured: false,
    },
    retry: { ...DEFAULT_PROVIDER_SETTINGS.retry },
    appearance: { ...DEFAULT_PROVIDER_SETTINGS.appearance },
    uiLanguage: DEFAULT_PROVIDER_SETTINGS.uiLanguage,
  };
}

function toDraft(settings: PublicProviderSettings): ProviderSettingsDraft {
  return {
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
  client,
  getBrowserUiLanguage = browserUiLanguage,
}: AppProps) {
  const [activeClient] = useState(() => client ?? createBrowserOptionsClient());
  const [settings, setSettings] = useState(publicDefaults);
  const [draft, setDraft] = useState(() => toDraft(publicDefaults()));
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [microsoftApiKey, setMicrosoftApiKey] = useState("");
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<MessageDescriptor>({
    id: "options.loading",
  });
  const [error, setError] = useState<ErrorCode | null>(null);
  const locale = resolveUiLocale(
    draft.uiLanguage,
    readBrowserUiLanguage(getBrowserUiLanguage),
  );

  const applySettings = (next: PublicProviderSettings) => {
    setSettings(next);
    setDraft(toDraft(next));
  };

  useEffect(() => {
    let active = true;
    void activeClient.load().then(
      (loaded) => {
        if (active) {
          applySettings(loaded);
          setStatus({ id: "settings.loaded" });
          setBusy(false);
        }
      },
      (loadError: unknown) => {
        if (active) {
          setError(sanitizeError(loadError).code);
          setBusy(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [activeClient]);

  const runAction = async (
    action: () => Promise<OptionsActionResult>,
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      applySettings(result.settings);
      setOpenaiApiKey("");
      setMicrosoftApiKey("");
      setStatus(result.message);
    } catch (actionError) {
      setError(sanitizeError(actionError).code);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const replacements: ApiKeyReplacements = {
      ...(openaiApiKey === "" ? {} : { openaiApiKey }),
      ...(microsoftApiKey === "" ? {} : { microsoftApiKey }),
    };
    return runAction(() => activeClient.save(draft, replacements));
  };

  const updateAppearance = <Key extends keyof AppearanceSettings>(
    key: Key,
    value: AppearanceSettings[Key],
  ) => {
    setDraft((current) => ({
      ...current,
      appearance: { ...current.appearance, [key]: value },
    }));
  };

  return (
    <main
      className="options"
      aria-labelledby="options-title"
      aria-busy={busy}
      lang={locale}
    >
      <p className="eyebrow">Paralume</p>
      <h1 id="options-title">{formatMessage(locale, "options.options")}</h1>

      <div className="options-grid">
        <section aria-labelledby="language-title">
          <h2 id="language-title">
            {formatMessage(locale, "options.language")}
          </h2>
          <label>
            {formatMessage(locale, "options.language")}
            <select
              name="uiLanguage"
              value={draft.uiLanguage}
              disabled={busy}
              onChange={(event) => {
                const uiLanguage = event.target
                  .value as ProviderSettingsDraft["uiLanguage"];
                setDraft((current) => ({ ...current, uiLanguage }));
              }}
            >
              <option value="system">
                {formatMessage(locale, "options.languageSystem")}
              </option>
              <option value="zh-CN">
                {formatMessage(locale, "options.languageSimplifiedChinese")}
              </option>
              <option value="en">
                {formatMessage(locale, "options.languageEnglish")}
              </option>
            </select>
          </label>
        </section>

        <section aria-labelledby="provider-title">
          <h2 id="provider-title">
            {formatMessage(locale, "options.translationProvider")}
          </h2>
          <label>
            {formatMessage(locale, "options.provider")}
            <select
              name="provider"
              value={draft.provider}
              disabled={busy}
              onChange={(event) => {
                const provider = event.target
                  .value as ProviderSettingsDraft["provider"];
                setDraft((current) => ({ ...current, provider }));
              }}
            >
              <option value="mock">
                {formatMessage(locale, "options.providerMock")}
              </option>
              <option value="openai">
                {formatMessage(locale, "options.providerOpenAi")}
              </option>
              <option value="microsoft">
                {formatMessage(locale, "options.providerMicrosoft")}
              </option>
            </select>
          </label>

          {draft.provider === "mock" ? (
            <p className="notice">
              {formatMessage(locale, "options.mockNotice")}
            </p>
          ) : null}

          {draft.provider === "openai" ? (
            <div className="provider-fields" data-provider="openai">
              <p className="notice">
                {formatMessage(locale, "options.openAiCompatibilityNotice")}
              </p>
              <label>
                {formatMessage(locale, "options.protocol")}
                <select
                  name="openaiProtocol"
                  value={draft.openai.protocol}
                  disabled={busy}
                  onChange={(event) => {
                    const protocol = event.target
                      .value as ProviderSettingsDraft["openai"]["protocol"];
                    setDraft((current) => ({
                      ...current,
                      openai: { ...current.openai, protocol },
                    }));
                  }}
                >
                  <option value="responses">Responses</option>
                  <option value="chat-completions">Chat Completions</option>
                </select>
              </label>
              <label>
                {formatMessage(locale, "options.baseUrl")}
                <input
                  name="openaiBaseUrl"
                  type="url"
                  value={draft.openai.baseUrl}
                  disabled={busy}
                  onChange={(event) => {
                    const baseUrl = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      openai: { ...current.openai, baseUrl },
                    }));
                  }}
                />
              </label>
              <label>
                {formatMessage(locale, "options.model")}
                <input
                  name="openaiModel"
                  value={draft.openai.model}
                  disabled={busy}
                  onChange={(event) => {
                    const model = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      openai: { ...current.openai, model },
                    }));
                  }}
                />
              </label>
              <label>
                {formatMessage(locale, "options.reasoningEffort")}
                <select
                  name="openaiReasoningEffort"
                  value={draft.openai.reasoningEffort}
                  disabled={busy}
                  onChange={(event) => {
                    const reasoningEffort = event.target
                      .value as ProviderSettingsDraft["openai"]["reasoningEffort"];
                    setDraft((current) => ({
                      ...current,
                      openai: { ...current.openai, reasoningEffort },
                    }));
                  }}
                >
                  <option value="none">
                    {formatMessage(locale, "options.reasoningNone")}
                  </option>
                  <option value="minimal">
                    {formatMessage(locale, "options.reasoningMinimal")}
                  </option>
                  <option value="low">
                    {formatMessage(locale, "options.reasoningLow")}
                  </option>
                  <option value="medium">
                    {formatMessage(locale, "options.reasoningMedium")}
                  </option>
                  <option value="high">
                    {formatMessage(locale, "options.reasoningHigh")}
                  </option>
                </select>
              </label>
              <label>
                {formatMessage(locale, "options.apiKey")}
                <input
                  name="openaiApiKey"
                  type="password"
                  autoComplete="new-password"
                  value={openaiApiKey}
                  placeholder={formatMessage(
                    locale,
                    settings.openai.apiKeyConfigured
                      ? "options.apiKeyConfigured"
                      : "options.apiKeyEmpty",
                  )}
                  disabled={busy}
                  onChange={(event) => {
                    setOpenaiApiKey(event.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary danger"
                data-action="clear-openai-key"
                disabled={busy || !settings.openai.apiKeyConfigured}
                onClick={() =>
                  void runAction(() => activeClient.clearApiKey("openai"))
                }
              >
                {formatMessage(locale, "options.clearOpenAiKey")}
              </button>
            </div>
          ) : null}

          {draft.provider === "microsoft" ? (
            <div className="provider-fields" data-provider="microsoft">
              <label>
                {formatMessage(locale, "options.endpoint")}
                <input
                  name="microsoftEndpoint"
                  type="url"
                  value={draft.microsoft.endpoint}
                  disabled={busy}
                  onChange={(event) => {
                    const endpoint = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      microsoft: { ...current.microsoft, endpoint },
                    }));
                  }}
                />
              </label>
              <label>
                {formatMessage(locale, "options.region")}
                <input
                  name="microsoftRegion"
                  value={draft.microsoft.region}
                  disabled={busy}
                  onChange={(event) => {
                    const region = event.target.value;
                    setDraft((current) => ({
                      ...current,
                      microsoft: { ...current.microsoft, region },
                    }));
                  }}
                />
              </label>
              <label>
                {formatMessage(locale, "options.apiKey")}
                <input
                  name="microsoftApiKey"
                  type="password"
                  autoComplete="new-password"
                  value={microsoftApiKey}
                  placeholder={formatMessage(
                    locale,
                    settings.microsoft.apiKeyConfigured
                      ? "options.apiKeyConfigured"
                      : "options.apiKeyEmpty",
                  )}
                  disabled={busy}
                  onChange={(event) => {
                    setMicrosoftApiKey(event.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="secondary danger"
                data-action="clear-microsoft-key"
                disabled={busy || !settings.microsoft.apiKeyConfigured}
                onClick={() =>
                  void runAction(() => activeClient.clearApiKey("microsoft"))
                }
              >
                {formatMessage(locale, "options.clearMicrosoftKey")}
              </button>
            </div>
          ) : null}

          <p className="storage-warning">
            {formatMessage(locale, "options.storageWarning")}
          </p>
        </section>

        <section aria-labelledby="retry-title">
          <h2 id="retry-title">{formatMessage(locale, "options.retry")}</h2>
          <label className="checkbox-label">
            <input
              name="retryEnabled"
              type="checkbox"
              checked={draft.retry.enabled}
              disabled={busy}
              onChange={(event) => {
                const enabled = event.target.checked;
                setDraft((current) => ({
                  ...current,
                  retry: { ...current.retry, enabled },
                }));
              }}
            />
            {formatMessage(locale, "options.retryEnabled")}
          </label>
          <label>
            {formatMessage(locale, "options.retryMax")}
            <select
              name="retryMaxRetries"
              value={draft.retry.maxRetries}
              disabled={busy || !draft.retry.enabled}
              onChange={(event) => {
                const maxRetries = Number(event.target.value);
                setDraft((current) => ({
                  ...current,
                  retry: { ...current.retry, maxRetries },
                }));
              }}
            >
              <option value={0}>0</option>
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <p className="notice">
            {formatMessage(locale, "options.retryCostNotice")}
          </p>
        </section>

        <section aria-labelledby="appearance-title">
          <h2 id="appearance-title">
            {formatMessage(locale, "options.appearance")}
          </h2>
          <p>{formatMessage(locale, "options.appearanceNotice")}</p>
          <div className="field-grid">
            <label>
              {formatMessage(locale, "options.fontFamily")}
              <select
                name="appearanceFontFamily"
                value={draft.appearance.fontFamily}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance(
                    "fontFamily",
                    event.target.value as AppearanceSettings["fontFamily"],
                  );
                }}
              >
                <option value="system">
                  {formatMessage(locale, "options.fontFamilySystem")}
                </option>
                <option value="sans-serif">
                  {formatMessage(locale, "options.fontFamilySansSerif")}
                </option>
                <option value="serif">
                  {formatMessage(locale, "options.fontFamilySerif")}
                </option>
                <option value="monospace">
                  {formatMessage(locale, "options.fontFamilyMonospace")}
                </option>
              </select>
            </label>
            <label>
              {formatMessage(locale, "options.fontSize")}
              <input
                name="appearanceFontSize"
                type="number"
                min={12}
                max={32}
                step={1}
                value={draft.appearance.fontSize}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance("fontSize", Number(event.target.value));
                }}
              />
            </label>
            <label>
              {formatMessage(locale, "options.textColor")}
              <input
                name="appearanceTextColor"
                type="color"
                value={draft.appearance.textColor}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance("textColor", event.target.value);
                }}
              />
            </label>
            <label>
              {formatMessage(locale, "options.backgroundColor")}
              <input
                name="appearanceBackgroundColor"
                type="color"
                value={draft.appearance.backgroundColor}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance("backgroundColor", event.target.value);
                }}
              />
            </label>
            <label>
              {formatMessage(locale, "options.lineHeight")}
              <input
                name="appearanceLineHeight"
                type="number"
                min={1}
                max={2.5}
                step={0.1}
                value={draft.appearance.lineHeight}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance("lineHeight", Number(event.target.value));
                }}
              />
            </label>
            <label>
              {formatMessage(locale, "options.opacity")}
              <input
                name="appearanceOpacity"
                type="number"
                min={0.4}
                max={1}
                step={0.05}
                value={draft.appearance.opacity}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance("opacity", Number(event.target.value));
                }}
              />
            </label>
            <label>
              {formatMessage(locale, "options.verticalSpacing")}
              <input
                name="appearanceVerticalSpacing"
                type="number"
                min={0}
                max={32}
                step={1}
                value={draft.appearance.verticalSpacing}
                disabled={busy}
                onChange={(event) => {
                  updateAppearance(
                    "verticalSpacing",
                    Number(event.target.value),
                  );
                }}
              />
            </label>
          </div>
          <button
            type="button"
            className="secondary"
            data-action="reset-appearance"
            disabled={busy}
            onClick={() => {
              setDraft((current) => ({
                ...current,
                appearance: { ...DEFAULT_APPEARANCE_SETTINGS },
              }));
            }}
          >
            {formatMessage(locale, "options.resetAppearance")}
          </button>
        </section>
      </div>

      <div className="settings-actions">
        <button
          type="button"
          data-action="save"
          disabled={busy}
          onClick={() => void save()}
        >
          {formatMessage(locale, "options.save")}
        </button>
        <button
          type="button"
          className="secondary"
          data-action="test-connection"
          disabled={busy}
          onClick={() => void runAction(() => activeClient.testConnection())}
        >
          {formatMessage(locale, "options.testConnection")}
        </button>
      </div>
      <p className="notice" role="status">
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
