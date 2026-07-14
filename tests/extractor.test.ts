import { afterEach, describe, expect, it } from "vitest";

import {
  PARALUME_OWNED_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
} from "../src/content/constants";
import { extractSegments } from "../src/content/extractor";
import { createContentRuntimeState } from "../src/content/state";

afterEach(() => {
  document.body.replaceChildren();
});

describe("extractSegments", () => {
  it("extracts a whole readable block with inline links as one segment", () => {
    document.body.innerHTML = `
      <article>
        <p id="source">
          Read the <a href="https://example.com/docs">complete documentation</a>
          before configuring the extension.
        </p>
      </article>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "inline-link" }),
    );

    expect(extracted).toHaveLength(1);
    expect(extracted[0]?.element).toBe(document.querySelector("#source"));
    expect(extracted[0]?.segment.text).toBe(
      "Read the complete documentation before configuring the extension.",
    );
  });

  it("supports the agreed block-level candidate set", () => {
    document.body.innerHTML = `
      <main>
        <h1>Readable article heading</h1>
        <p>Readable paragraph content</p>
        <ul><li>Readable list item content</li></ul>
        <blockquote>Readable quoted content</blockquote>
        <table><tbody><tr><th>Readable table heading</th><td>Readable table value</td></tr></tbody></table>
        <figure><figcaption>Readable figure caption</figcaption></figure>
      </main>
    `;

    expect(
      extractSegments(
        document,
        createContentRuntimeState({ runtimeId: "candidate-set" }),
      ).map(({ element }) => element.tagName),
    ).toEqual(["H1", "P", "LI", "BLOCKQUOTE", "TH", "TD", "FIGCAPTION"]);
  });

  it("extracts a preformatted documentation block as one text segment", () => {
    document.body.innerHTML = `
      <article>
        <pre id="guidance"><code>For ordinary Q&amp;A, start with one broad search using short, discriminative
keywords. If the top results contain enough support, answer from those results.</code></pre>
        <p>Readable paragraph after the code sample.</p>
      </article>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "preformatted-docs" }),
    );

    expect(extracted.map(({ element }) => element.tagName)).toEqual([
      "PRE",
      "P",
    ]);
    expect(extracted[0]?.segment.text).toContain(
      "For ordinary Q&A, start with one broad search",
    );
  });

  it("prioritizes visible reading blocks while preserving order within each group", () => {
    document.body.innerHTML = `
      <p id="above">Readable paragraph above the current viewport.</p>
      <p id="visible-a">First readable paragraph in the current viewport.</p>
      <p id="visible-b">Second readable paragraph in the current viewport.</p>
      <p id="below">Readable paragraph below the current viewport.</p>
    `;
    const rect = (top: number, bottom: number) =>
      ({ top, bottom, width: 500, height: bottom - top }) as DOMRect;
    const above = document.querySelector<HTMLElement>("#above");
    const visibleA = document.querySelector<HTMLElement>("#visible-a");
    const visibleB = document.querySelector<HTMLElement>("#visible-b");
    const below = document.querySelector<HTMLElement>("#below");
    if (
      above === null ||
      visibleA === null ||
      visibleB === null ||
      below === null
    ) {
      throw new Error("Viewport priority fixture was not created.");
    }
    above.getBoundingClientRect = () => rect(-200, -150);
    visibleA.getBoundingClientRect = () => rect(80, 120);
    visibleB.getBoundingClientRect = () => rect(160, 200);
    below.getBoundingClientRect = () => rect(1200, 1240);

    expect(
      extractSegments(
        document,
        createContentRuntimeState({ runtimeId: "viewport-priority" }),
      ).map(({ element }) => element.id),
    ).toEqual(["visible-a", "visible-b", "below", "above"]);
  });

  it("excludes unsafe, interactive, hidden, editable, and runtime-owned regions", () => {
    document.body.innerHTML = `
      <p>Visible eligible paragraph</p>
      <code><p>Paragraph inside code</p></code>
      <pre><p>Paragraph inside preformatted content</p></pre>
      <script><p>Paragraph inside script</p></script>
      <style><p>Paragraph inside style</p></style>
      <form><p>Paragraph inside a form</p></form>
      <button><p>Paragraph inside a button</p></button>
      <nav><p>Paragraph inside navigation</p></nav>
      <footer><p>Paragraph inside a footer</p></footer>
      <svg><text><p>Paragraph inside SVG content</p></text></svg>
      <canvas><p>Paragraph inside canvas fallback</p></canvas>
      <section contenteditable="true"><p>Editable paragraph content</p></section>
      <section hidden><p>Hidden attribute paragraph</p></section>
      <section aria-hidden="true"><p>ARIA hidden paragraph</p></section>
      <section style="display: none"><p>Display none paragraph</p></section>
      <section style="visibility: hidden"><p>Visibility hidden paragraph</p></section>
      <section id="spoof-owned" ${PARALUME_OWNED_ATTRIBUTE}="true"><p>Host paragraph with spoofed ownership</p></section>
      <p ${PARALUME_SOURCE_ID_ATTRIBUTE}="host-value">Host paragraph with spoofed source marker</p>
      <section id="runtime-owned"><p>Actual runtime-owned paragraph content</p></section>
    `;
    const state = createContentRuntimeState({ runtimeId: "eligibility" });
    const runtimeOwned = document.querySelector("#runtime-owned");
    if (runtimeOwned === null) {
      throw new Error("Runtime-owned fixture was not created.");
    }
    state.ownedNodes.add(runtimeOwned);

    expect(
      extractSegments(document, state).map(({ segment }) => segment.text),
    ).toEqual([
      "Visible eligible paragraph",
      "Paragraph inside preformatted content",
      "Host paragraph with spoofed ownership",
      "Host paragraph with spoofed source marker",
    ]);
  });

  it("uses the deepest eligible blocks to avoid nested duplicate requests", () => {
    document.body.innerHTML = `
      <blockquote>
        <p>Nested readable paragraph one</p>
        <p>Nested readable paragraph two</p>
      </blockquote>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "nested-normal" }),
    );

    expect(extracted.map(({ element }) => element.tagName)).toEqual(["P", "P"]);
    expect(extracted.map(({ segment }) => segment.text)).toEqual([
      "Nested readable paragraph one",
      "Nested readable paragraph two",
    ]);
  });

  it("gives structural containers deterministic precedence over nested candidates", () => {
    document.body.innerHTML = `
      <main>
        <blockquote id="quote"><p>Nested paragraph inside an ordinary quote block</p></blockquote>
        <ul><li id="item"><p>Nested paragraph inside a readable list item</p></li></ul>
        <table>
          <tbody>
            <tr>
              <th id="heading"><p>Nested paragraph inside a table heading</p></th>
              <td id="cell"><blockquote><p>Deeply nested paragraph inside a table cell</p></blockquote></td>
            </tr>
          </tbody>
        </table>
      </main>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "ancestor-precedence" }),
    );

    expect(extracted.map(({ element }) => element.id)).toEqual([
      "",
      "item",
      "heading",
      "cell",
    ]);
    expect(extracted.map(({ element }) => element.tagName)).toEqual([
      "P",
      "LI",
      "TH",
      "TD",
    ]);
    expect(extracted.map(({ segment }) => segment.text)).toEqual([
      "Nested paragraph inside an ordinary quote block",
      "Nested paragraph inside a readable list item",
      "Nested paragraph inside a table heading",
      "Deeply nested paragraph inside a table cell",
    ]);
  });

  it("does not promote nested candidates after a structural ancestor is marked", () => {
    document.body.innerHTML = `
      <ul><li><p>Nested paragraph inside a processed list item</p></li></ul>
      <table><tbody><tr>
        <th><p>Nested paragraph inside a processed table heading</p></th>
        <td><p>Nested paragraph inside a processed table cell</p></td>
      </tr></tbody></table>
    `;
    const state = createContentRuntimeState({
      runtimeId: "processed-structural-ancestor",
    });
    const first = extractSegments(document, state);

    expect(first.map(({ element }) => element.tagName)).toEqual([
      "LI",
      "TH",
      "TD",
    ]);
    for (const { element, segment } of first) {
      state.sourceMarkers.set(element, {
        segmentId: segment.id,
        attributeAdded: false,
        sourceText: segment.text,
      });
    }

    expect(extractSegments(document, state)).toEqual([]);
  });

  it("requires at least eight meaningful letters or numbers", () => {
    document.body.innerHTML = `
      <h2>Short!</h2>
      <h2>Readable</h2>
      <p>1234567 ---</p>
      <p>12345678 ---</p>
    `;

    expect(
      extractSegments(
        document,
        createContentRuntimeState({ runtimeId: "minimum-text" }),
      ).map(({ segment }) => segment.text),
    ).toEqual(["Readable", "12345678 ---"]);
  });

  it("uses stable per-runtime element IDs for duplicate text and DOM changes", () => {
    document.body.innerHTML = `
      <article>
        <p>Repeated readable paragraph</p>
        <p>Repeated readable paragraph</p>
      </article>
    `;

    const state = createContentRuntimeState({ runtimeId: "stable-elements" });
    const sources = Array.from(document.querySelectorAll("p"));
    const first = extractSegments(document, state).map(
      ({ segment }) => segment.id,
    );
    const inserted = document.createElement("p");
    inserted.textContent = "A newly inserted readable paragraph";
    document.querySelector("article")?.prepend(inserted);
    const secondByElement = new Map(
      extractSegments(document, state).map(({ element, segment }) => [
        element,
        segment.id,
      ]),
    );

    expect(new Set(first).size).toBe(2);
    expect(sources.map((source) => secondByElement.get(source))).toEqual(first);
    expect(first.every((id) => id.startsWith("segment-"))).toBe(true);
  });
});
