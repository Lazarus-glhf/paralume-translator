export function App() {
  return (
    <main className="options" aria-labelledby="options-title">
      <p className="eyebrow">Paralume</p>
      <h1 id="options-title">Options</h1>
      <section aria-labelledby="foundation-title">
        <h2 id="foundation-title">Foundation build</h2>
        <p>
          Provider and reading preferences will live here after their behavior
          and privacy boundaries are defined.
        </p>
        <p className="notice" role="status">
          There are no configurable settings in Milestone 0.
        </p>
      </section>
    </main>
  );
}
