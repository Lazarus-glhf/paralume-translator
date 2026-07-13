import { useState } from "react";

import type {
  ContentCommand,
  ContentResponse,
} from "../../src/messaging/protocol";
import { runPageCommand } from "../../src/popup/client";
import type { ContentState } from "../../src/shared/types";

export interface AppProps {
  runCommand?: (command: ContentCommand) => Promise<ContentResponse>;
}

const INITIAL_STATE: ContentState = {
  translationCount: 0,
  failureCount: 0,
  visible: true,
};

export function App({ runCommand = runPageCommand }: AppProps) {
  const [busy, setBusy] = useState(false);
  const [pageState, setPageState] = useState(INITIAL_STATE);
  const [status, setStatus] = useState(
    "Ready to translate eligible text on the current page.",
  );
  const [error, setError] = useState<string | null>(null);

  const handleAction = async (command: ContentCommand) => {
    setBusy(true);
    setError(null);
    setStatus("Working on the current page…");

    try {
      const response = await runCommand(command);
      if (response.ok) {
        setPageState(response.state);
        setStatus(response.message);
      } else {
        setError(response.error.message);
      }
    } catch {
      setStatus("The page action did not complete.");
      setError("Paralume could not complete this action. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="popup" aria-labelledby="popup-title" aria-busy={busy}>
      <p className="eyebrow">Bilingual reading with Mock mode</p>
      <h1 id="popup-title">Paralume</h1>
      <p className="summary">
        Add deterministic Mock translations below readable blocks on this page.
      </p>

      <div className="actions" aria-label="Page translation controls">
        <button
          type="button"
          data-action="translate"
          disabled={busy}
          onClick={() => void handleAction("translate")}
        >
          Translate current page
        </button>
        <button
          type="button"
          className="secondary"
          data-action="toggle"
          disabled={busy}
          onClick={() => void handleAction("toggle")}
        >
          {pageState.visible ? "Hide" : "Show"} translations
        </button>
        <button
          type="button"
          className="secondary danger"
          data-action="clear"
          disabled={busy}
          onClick={() => void handleAction("clear")}
        >
          Clear translations
        </button>
      </div>

      <p className="status" role="status">
        {status}
      </p>
      {error === null ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
