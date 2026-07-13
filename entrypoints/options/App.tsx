export function App() {
  return (
    <main className="options" aria-labelledby="options-title">
      <p className="eyebrow">Paralume</p>
      <h1 id="options-title">Options</h1>
      <section aria-labelledby="provider-title">
        <h2 id="provider-title">Translation provider</h2>
        <p>
          Milestone 1 uses a deterministic local Mock provider to verify page
          extraction, messaging, batching, and rendering. It does not contact a
          translation service and does not produce real translations.
        </p>
        <p className="notice" role="status">
          Mock provider is active. There are no configurable API settings.
        </p>
      </section>
    </main>
  );
}
