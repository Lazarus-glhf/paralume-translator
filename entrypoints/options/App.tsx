import { useEffect, useState } from "react";

import {
  createBrowserOptionsClient,
  type OptionsClient,
} from "../../src/options/client";
import { DEFAULT_PROVIDER_SETTINGS } from "../../src/settings/repository";
import type {
  ApiKeyReplacements,
  ProviderSettingsDraft,
  PublicProviderSettings,
} from "../../src/settings/types";
import { safeMessageFromUnknown } from "../../src/shared/errors";

export interface AppProps {
  client?: OptionsClient;
}

function publicDefaults(): PublicProviderSettings {
  return {
    version: 1,
    provider: DEFAULT_PROVIDER_SETTINGS.provider,
    openai: {
      ...DEFAULT_PROVIDER_SETTINGS.openai,
      apiKeyConfigured: false,
    },
    microsoft: {
      ...DEFAULT_PROVIDER_SETTINGS.microsoft,
      apiKeyConfigured: false,
    },
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
  };
}

export function App({ client }: AppProps) {
  const [activeClient] = useState(() => client ?? createBrowserOptionsClient());
  const [settings, setSettings] = useState(publicDefaults);
  const [draft, setDraft] = useState(() => toDraft(publicDefaults()));
  const [openaiApiKey, setOpenaiApiKey] = useState("");
  const [microsoftApiKey, setMicrosoftApiKey] = useState("");
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState("Loading provider settings…");
  const [error, setError] = useState<string | null>(null);

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
          setStatus("Provider settings loaded.");
          setBusy(false);
        }
      },
      (loadError: unknown) => {
        if (active) {
          setError(safeMessageFromUnknown(loadError));
          setBusy(false);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [activeClient]);

  const runAction = async (
    action: () => Promise<{
      settings: PublicProviderSettings;
      message: string;
    }>,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      applySettings(result.settings);
      setOpenaiApiKey("");
      setMicrosoftApiKey("");
      setStatus(result.message);
    } catch (actionError) {
      setError(safeMessageFromUnknown(actionError));
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

  return (
    <main className="options" aria-labelledby="options-title" aria-busy={busy}>
      <p className="eyebrow">Paralume</p>
      <h1 id="options-title">Options</h1>

      <section aria-labelledby="provider-title">
        <h2 id="provider-title">Translation provider</h2>
        <label>
          Provider
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
            <option value="mock">Mock (development only)</option>
            <option value="openai">OpenAI-compatible</option>
            <option value="microsoft">Microsoft Translator</option>
          </select>
        </label>

        {draft.provider === "mock" ? (
          <p className="notice">
            Mock is deterministic development output and is never selected as an
            automatic fallback.
          </p>
        ) : null}

        {draft.provider === "openai" ? (
          <div className="provider-fields" data-provider="openai">
            <p className="notice">
              The selected endpoint must support strict json_schema output and
              the chosen protocol&apos;s reasoning field. Chat Completions may
              return string content or arrays containing only text parts;
              unsupported content parts are rejected.
            </p>
            <label>
              Protocol
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
              HTTPS Base URL
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
              Model
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
              Reasoning effort
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
                <option value="none">None</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label>
              API key
              <input
                name="openaiApiKey"
                type="password"
                autoComplete="new-password"
                value={openaiApiKey}
                placeholder={
                  settings.openai.apiKeyConfigured
                    ? "API key configured; leave blank to keep it"
                    : "Enter API key"
                }
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
              Clear OpenAI-compatible key
            </button>
          </div>
        ) : null}

        {draft.provider === "microsoft" ? (
          <div className="provider-fields" data-provider="microsoft">
            <label>
              HTTPS Endpoint
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
              Region
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
              API key
              <input
                name="microsoftApiKey"
                type="password"
                autoComplete="new-password"
                value={microsoftApiKey}
                placeholder={
                  settings.microsoft.apiKeyConfigured
                    ? "API key configured; leave blank to keep it"
                    : "Enter API key"
                }
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
              Clear Microsoft key
            </button>
          </div>
        ) : null}

        <p className="storage-warning">
          API keys are stored in chrome.storage.local on this browser profile.
          This local storage is not an encrypted vault.
        </p>
        <div className="settings-actions">
          <button
            type="button"
            data-action="save"
            disabled={busy}
            onClick={() => void save()}
          >
            Save settings
          </button>
          <button
            type="button"
            className="secondary"
            data-action="test-connection"
            disabled={busy}
            onClick={() => void runAction(() => activeClient.testConnection())}
          >
            Test saved provider
          </button>
        </div>
        <p className="notice" role="status">
          {status}
        </p>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}
