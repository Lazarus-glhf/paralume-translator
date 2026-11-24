import { afterEach, describe, expect, it } from "vitest";

import {
  PARALUME_OWNED_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
} from "../src/content/constants";
import { extractSegments } from "../src/content/extractor";
import { renderTranslation } from "../src/content/renderer";
import { createContentRuntimeState } from "../src/content/state";
import { getCurrentSourceText } from "../src/content/text";
import type { SourceSegment, TranslationResult } from "../src/shared/types";

function success(segment: SourceSegment): TranslationResult {
  return {
    id: segment.id,
    status: "success",
    translatedText: `Translated ${segment.text}`,
  };
}

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

  it("preserves explicit line breaks and blank lines inside a readable block", () => {
    document.body.innerHTML = `
      <p id="formatted">Resolve the customer's issue end to end.<br><br>Success means:<br>- make the eligibility decision from available policy and account evidence<br>- complete any allowed action before responding<br>- return completed_actions, customer_message, and blockers<br>- if required evidence is missing, ask for the smallest missing field</p>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "line-breaks" }),
    );

    expect(extracted[0]?.segment.text).toBe(
      "Resolve the customer's issue end to end.\n\nSuccess means:\n- make the eligibility decision from available policy and account evidence\n- complete any allowed action before responding\n- return completed_actions, customer_message, and blockers\n- if required evidence is missing, ask for the smallest missing field",
    );
  });

  it("does not treat HTML source indentation as visible line breaks", () => {
    document.body.innerHTML = `
      <p id="indented">
        Read the <a href="https://example.com/docs">complete documentation</a>
        before configuring the extension.
      </p>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "source-indentation" }),
    );

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

  it("extracts a plain preformatted prose block as one text segment with its line layout", () => {
    document.body.innerHTML = `
      <article>
        <pre id="guidance">For ordinary Q&amp;A, start with one broad search using short, discriminative
    keywords. If the top results contain enough support, answer from those results.</pre>
        <p>Readable paragraph after the preformatted guidance.</p>
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
    expect(extracted[0]?.segment.text).toBe(
      "For ordinary Q&A, start with one broad search using short, discriminative\nkeywords. If the top results contain enough support, answer from those results.",
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

  it("omits hidden, script, style, interactive, and editable descendants from segment text", () => {
    document.body.innerHTML = `
      <p id="mixed">Visible paragraph keeps its readable words <script>window.leak = "SCRIPT_SECRET_TEXT";</script><style>.STYLE_SECRET_TEXT { color: red; }</style><noscript>NOSCRIPT_SECRET</noscript><span hidden>HIDDEN_ATTRIBUTE_SECRET</span><span style="display: none">DISPLAY_NONE_SECRET</span><span aria-hidden="true">ARIA_HIDDEN_SECRET</span><button type="button">BUTTON_SECRET</button><input value="INPUT_SECRET"><span contenteditable="true">EDITABLE_SECRET</span><code>inlineCode()</code> and a normal ending.</p>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "hidden-descendants" }),
    );

    expect(extracted.map(({ segment }) => segment.text)).toEqual([
      "Visible paragraph keeps its readable words inlineCode() and a normal ending.",
    ]);
  });

  it("does not make a block eligible through hidden descendant text alone", () => {
    document.body.innerHTML = `
      <p>Tiny <span style="display: none">but hidden text is long enough</span></p>
    `;

    expect(
      extractSegments(
        document,
        createContentRuntimeState({ runtimeId: "hidden-only" }),
      ),
    ).toEqual([]);
  });

  it("separates adjacent block children instead of gluing their text", () => {
    document.body.innerHTML = `<ul><li id="glued"><div>First glued sentence.</div><div>Second glued sentence.</div></li></ul>`;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "block-separators" }),
    );

    expect(extracted.map(({ element }) => element.id)).toEqual(["glued"]);
    expect(extracted[0]?.segment.text).toBe(
      "First glued sentence. Second glued sentence.",
    );
  });

  it("splits nested lists into their own items and keeps the parent's loose text", () => {
    document.body.innerHTML = `
      <ul>
        <li id="outer">Outer list item introduction text
          <ul>
            <li id="inner-one">Inner list item number one</li>
            <li id="inner-two">Inner list item number two</li>
          </ul>
        </li>
        <li id="code-item">List item explaining the snippet below<pre id="code-pre">const snippet = "kept apart";</pre></li>
      </ul>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "nested-lists" }),
    );

    expect(
      Object.fromEntries(
        extracted.map(({ element, segment }) => [element.id, segment.text]),
      ),
    ).toEqual({
      outer: "Outer list item introduction text",
      "inner-one": "Inner list item number one",
      "inner-two": "Inner list item number two",
      "code-item": "List item explaining the snippet below",
      "code-pre": 'const snippet = "kept apart";',
    });
  });

  it("splits layout table cells that wrap nested tables or several blocks", () => {
    document.body.innerHTML = `
      <table><tbody><tr><td id="layout-cell">
        <table><tbody>
          <tr><td id="story-title">Layout table story title text</td></tr>
          <tr><td id="story-meta">Layout table story metadata line</td></tr>
        </tbody></table>
      </td></tr></tbody></table>
      <table><tbody><tr><td id="article-cell">
        <p id="paragraph-one">Layout cell paragraph number one.</p>
        <p id="paragraph-two">Layout cell paragraph number two.</p>
      </td></tr></tbody></table>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "layout-tables" }),
    );

    expect(
      Object.fromEntries(
        extracted.map(({ element, segment }) => [element.id, segment.text]),
      ),
    ).toEqual({
      "story-title": "Layout table story title text",
      "story-meta": "Layout table story metadata line",
      "paragraph-one": "Layout cell paragraph number one.",
      "paragraph-two": "Layout cell paragraph number two.",
    });
  });

  it("keeps compound container sources stable once translations are inserted", () => {
    document.body.innerHTML = `
      <ul>
        <li id="outer">Outer list item introduction text
          <ul><li id="inner">Inner list item number one</li></ul>
        </li>
      </ul>
    `;
    const state = createContentRuntimeState({ runtimeId: "compound-stable" });
    const first = extractSegments(document, state);
    expect(first.map(({ element }) => element.id)).toEqual(["outer", "inner"]);

    for (const { element, segment } of first) {
      const translation = document.createElement("div");
      translation.textContent = `Translated ${segment.text}`;
      element.append(translation);
      state.ownedNodes.add(translation);
      state.sourceMarkers.set(element, {
        segmentId: segment.id,
        attributeAdded: false,
        sourceText: segment.text,
      });
    }

    for (const { element, segment } of first) {
      expect(getCurrentSourceText(element, state)).toBe(segment.text);
    }
    expect(extractSegments(document, state)).toEqual([]);
    expect(state.sourceMarkers.size).toBe(2);
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

describe("extractSegments mixed loose text and nested blocks", () => {
  function textsById(runtimeId: string): Record<string, string> {
    return Object.fromEntries(
      extractSegments(document, createContentRuntimeState({ runtimeId })).map(
        ({ element, segment }) => [element.id, segment.text],
      ),
    );
  }

  it("keeps short nested blocks inside their list item or table cell", () => {
    document.body.innerHTML = `
      <ul><li id="item"><p>Step one opens the settings page</p><p>Done.</p></li></ul>
      <table><tbody><tr>
        <td id="cell">Total amount due today <p>$5</p><p>USD</p></td>
      </tr></tbody></table>
    `;

    expect(textsById("short-nested")).toEqual({
      item: "Step one opens the settings page Done.",
      cell: "Total amount due today $5 USD",
    });
  });

  it("translates a container's loose text once without its nested blocks", () => {
    document.body.innerHTML = `
      <blockquote id="quote">Quote introduction loose text <p id="quoted">Quoted paragraph text here</p></blockquote>
      <ul><li id="item">
        <blockquote id="item-quote">Nested quote loose text<p id="item-quoted">Nested quoted paragraph</p></blockquote>
        <p id="item-paragraph">Another paragraph in the item</p>
      </li></ul>
    `;

    expect(textsById("loose-text")).toEqual({
      quote: "Quote introduction loose text",
      quoted: "Quoted paragraph text here",
      "item-quote": "Nested quote loose text",
      "item-quoted": "Nested quoted paragraph",
      "item-paragraph": "Another paragraph in the item",
    });
  });

  it("is idempotent for containers with loose text once they are translated", () => {
    document.body.innerHTML = `
      <blockquote id="quote">Quote introduction loose text <p id="quoted">Quoted paragraph text here</p></blockquote>
    `;
    const state = createContentRuntimeState({ runtimeId: "loose-idempotent" });
    const first = extractSegments(document, state);
    for (const extracted of first) {
      renderTranslation(extracted, success(extracted.segment), state);
    }

    expect(first.map(({ element }) => element.id)).toEqual(["quote", "quoted"]);
    expect(extractSegments(document, state)).toEqual([]);
  });

  it("drops nested translations when a compound item becomes merged", () => {
    document.body.innerHTML = `
      <ul><li id="item">Item introduction loose text
        <p id="first">First nested paragraph text</p>
        <p id="second">Second nested paragraph text</p>
      </li></ul>
    `;
    const state = createContentRuntimeState({ runtimeId: "compound-merge" });
    const first = extractSegments(document, state);
    expect(first.map(({ element }) => element.id)).toEqual([
      "item",
      "first",
      "second",
    ]);
    for (const extracted of first) {
      renderTranslation(extracted, success(extracted.segment), state);
    }

    expect(document.body.textContent).toContain(
      "Translated First nested paragraph text",
    );

    // The page removes one nested block; the item now owns the other one.
    document.querySelector("#second")?.remove();
    const second = extractSegments(document, state);

    expect(
      second.map(({ element, segment }) => [element.id, segment.text]),
    ).toEqual([
      ["item", "Item introduction loose text First nested paragraph text"],
    ]);
    const firstParagraph = document.querySelector<HTMLElement>("#first");
    expect(
      firstParagraph !== null && state.sourceMarkers.has(firstParagraph),
    ).toBe(false);
    expect(document.body.textContent).not.toContain(
      "Translated First nested paragraph text",
    );
  });
});

describe("extractSegments content-visibility", () => {
  it("skips content-visibility: hidden on the block, an ancestor, or a non-inline descendant", () => {
    document.body.innerHTML = `
      <section style="content-visibility: hidden">
        <p id="ancestor-hidden">ANCESTOR_CV_SECRET recovery phrase text</p>
      </section>
      <p id="self-hidden" style="content-visibility: hidden">SELF_CV_SECRET paragraph text</p>
      <p id="mixed">Visible part of the paragraph <span style="display: inline-block; content-visibility: hidden">DESCENDANT_CV_SECRET</span><span style="display: inline; content-visibility: hidden">kept inline</span> and its ending.</p>
      <p id="auto" style="content-visibility: auto">Deferred but readable paragraph</p>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "content-visibility" }),
    );

    expect(
      Object.fromEntries(
        extracted.map(({ element, segment }) => [element.id, segment.text]),
      ),
    ).toEqual({
      // content-visibility has no effect on a plain inline box.
      mixed: "Visible part of the paragraph kept inline and its ending.",
      auto: "Deferred but readable paragraph",
    });
  });
});

describe("extractSegments code blocks and the translate attribute", () => {
  function extractTexts(runtimeId: string): Record<string, string> {
    return Object.fromEntries(
      extractSegments(document, createContentRuntimeState({ runtimeId })).map(
        ({ element, segment }) => [element.id, segment.text],
      ),
    );
  }

  it("skips a Shiki code block wrapped in translate=no and unmarked semantic code blocks", () => {
    // The structure of the C# SDK page on the Claude documentation site.
    document.body.innerHTML = `
      <article>
        <p id="intro">Create a client and send your first message from C#:</p>
        <div class="code-block" translate="no"><pre id="shiki" class="shiki github-light" tabindex="0"><code><span class="line"><span style="color:#D73A49">using</span><span> Anthropic;</span></span>
<span class="line"><span style="color:#D73A49">var</span><span> client = </span><span style="color:#D73A49">new</span><span> AnthropicClient();</span></span>
<span class="line"><span>// Sends one message to the selected Claude model</span></span></code></pre></div>
        <pre id="unmarked"><code>var message = await client.Messages.Create(parameters);</code></pre>
        <pre id="sample-output"><samp>Message created with the requested parameters</samp></pre>
        <code id="block-code" style="display: block">Console.WriteLine(message.Content);</code>
        <p id="outro">The response contains the generated assistant message.</p>
      </article>
    `;
    const shiki = document.querySelector("#shiki > code > span");

    expect(
      shiki?.closest('[translate="no"] > pre.shiki > code'),
    ).not.toBeNull();
    expect(extractTexts("shiki")).toEqual({
      intro: "Create a client and send your first message from C#:",
      outro: "The response contains the generated assistant message.",
    });
  });

  it("does not merge short commands into list items or table cells", () => {
    document.body.innerHTML = `
      <ol>
        <li id="pre-step">Run the restore command in the project directory <pre><code>dotnet restore</code></pre></li>
        <li id="shiki-step">Install the SDK package for your project <div translate="no"><pre class="shiki"><code><span class="line"><span>dotnet add package Anthropic</span></span></code></pre></div></li>
        <li id="paragraph-step"><p>Build the release artifacts locally</p><p><code>make</code></p></li>
        <li><pre><code>dotnet run --project Samples</code></pre></li>
      </ol>
      <table><tbody>
        <tr><td><code>max_tokens</code></td><td id="description">The maximum number of tokens to generate</td></tr>
        <tr><td id="command-cell">Restores package dependencies <div><code>dotnet restore</code></div></td><td><kbd>Ctrl</kbd>+<kbd>C</kbd></td></tr>
      </tbody></table>
    `;

    const extracted = extractSegments(
      document,
      createContentRuntimeState({ runtimeId: "short-commands" }),
    );

    expect(
      Object.fromEntries(
        extracted.map(({ element, segment }) => [element.id, segment.text]),
      ),
    ).toEqual({
      "pre-step": "Run the restore command in the project directory",
      "shiki-step": "Install the SDK package for your project",
      "paragraph-step": "Build the release artifacts locally",
      description: "The maximum number of tokens to generate",
      "command-cell": "Restores package dependencies",
    });
    expect(
      extracted.some(
        ({ segment }) =>
          segment.text.includes("dotnet") || segment.text.includes("make"),
      ),
    ).toBe(false);
  });

  it("translates a pre that mixes prose with inline code markup", () => {
    document.body.innerHTML = `
      <pre id="mixed-pre">Press <kbd>Enter</kbd> to continue reading.</pre>
      <pre id="code-pre"><code>npm ci</code>
</pre>
    `;

    expect(extractTexts("mixed-pre")).toEqual({
      "mixed-pre": "Press Enter to continue reading.",
    });
  });

  it("keeps a block boundary where a skipped code block was removed", () => {
    document.body.innerHTML = `
      <ul><li id="install">Install dependencies<pre><code>npm ci</code></pre>before building.</li></ul>
    `;

    expect(extractTexts("code-boundary")).toEqual({
      install: "Install dependencies before building.",
    });
  });

  it("adds no gap where unrendered or extension-owned nodes were skipped", () => {
    document.body.innerHTML = `
      <ul>
        <li id="hidden-attr">micro<div hidden>hidden</div>scope is ready</li>
        <li id="display-none">micro<div style="display: none">hidden</div>scope is ready</li>
        <li id="aria-hidden">micro<div aria-hidden="true">hidden</div>scope is ready</li>
        <li id="hidden-code">micro<pre hidden><code>npm ci</code></pre>scope is ready</li>
        <li id="none-code">micro<code style="display: none">npm ci</code>scope is ready</li>
        <li id="owned">micro<div id="owned-node">Paralume UI</div>scope is ready</li>
      </ul>
    `;
    const state = createContentRuntimeState({ runtimeId: "skipped-gaps" });
    const owned = document.querySelector("#owned-node");
    if (owned === null) {
      throw new Error("Owned node fixture was not created.");
    }
    state.ownedNodes.add(owned);

    const texts = Object.fromEntries(
      extractSegments(document, state).map(({ element, segment }) => [
        element.id,
        segment.text,
      ]),
    );
    expect(texts).toEqual({
      "hidden-attr": "microscope is ready",
      "display-none": "microscope is ready",
      "aria-hidden": "microscope is ready",
      "hidden-code": "microscope is ready",
      "none-code": "microscope is ready",
      owned: "microscope is ready",
    });
    for (const id of Object.keys(texts)) {
      const element = document.getElementById(id);
      if (element === null) {
        throw new Error(`Missing fixture ${id}.`);
      }
      expect(getCurrentSourceText(element, state)).toBe("microscope is ready");
    }
  });

  it("keeps inline code and inline translate=no runs inside prose as context", () => {
    document.body.innerHTML = `
      <p id="inline">Call <code>client.Messages.Create</code> and press <kbd>Enter</kbd> to send it.</p>
      <ul><li id="inline-item">Set <code>ANTHROPIC_API_KEY</code> before running the sample</li></ul>
      <p id="brand">Paralume works with <span translate="no">Claude</span> models today.</p>
      <p id="identifier-only"><span translate="no">claude-opus-model-identifier</span></p>
      <p id="code-only"><code>client.Messages.Create(parameters)</code></p>
    `;

    expect(extractTexts("inline-code")).toEqual({
      inline: "Call client.Messages.Create and press Enter to send it.",
      "inline-item": "Set ANTHROPIC_API_KEY before running the sample",
      brand: "Paralume works with Claude models today.",
    });
  });

  it("inherits the nearest valid translate value and lets yes restore translation", () => {
    document.body.innerHTML = `
      <div translate="no">
        <p id="inherited-no">Inherited no-translate paragraph</p>
        <p id="invalid-value" translate="maybe">Invalid value keeps the inherited state</p>
        <p id="padded-value" translate=" yes ">Padded value is invalid and inherits no</p>
        <section translate=""><p id="empty-yes">Empty translate value restores translation</p></section>
        <p id="restored" translate="YES">Uppercase yes restores this paragraph <span translate="no">ProductName</span> too</p>
        <blockquote id="protected-quote">Protected quote text <p id="quote-restored" translate="yes">Restored paragraph inside the quote</p></blockquote>
      </div>
      <p id="top-invalid" translate="nope">Invalid value at the top keeps the default</p>
      <p id="explicit-no" translate="No">Explicitly protected paragraph text</p>
      <ul>
        <li id="protected-block-item">List item prose stays translatable <div translate="no"><p>Protected nested paragraph text</p></div></li>
        <li id="restored-run-item">Intro sentence for the item <div translate="no">protected words <span translate="yes">and restored words</span></div></li>
      </ul>
    `;

    expect(extractTexts("translate-attribute")).toEqual({
      "empty-yes": "Empty translate value restores translation",
      restored: "Uppercase yes restores this paragraph ProductName too",
      "quote-restored": "Restored paragraph inside the quote",
      "top-invalid": "Invalid value at the top keeps the default",
      "protected-block-item": "List item prose stays translatable",
      "restored-run-item": "Intro sentence for the item and restored words",
    });
  });

  it("applies the same translate and code rules to source checks", () => {
    document.body.innerHTML = `
      <p id="paragraph">Paragraph the page protects later <span id="name" translate="no">Paralume</span> today</p>
      <ul><li id="item">List item explaining the command below <div id="command"><code>dotnet restore</code></div></li></ul>
    `;
    const state = createContentRuntimeState({ runtimeId: "source-checks" });
    const first = extractSegments(document, state);
    for (const extracted of first) {
      expect(getCurrentSourceText(extracted.element, state)).toBe(
        extracted.segment.text,
      );
      renderTranslation(extracted, success(extracted.segment), state);
    }
    expect(first.map(({ element }) => element.id)).toEqual([
      "paragraph",
      "item",
    ]);
    expect(extractSegments(document, state)).toEqual([]);

    // Neither restoring the inline run nor protecting the command block
    // changes what is read, so both translations stay current.
    document.querySelector("#name")?.setAttribute("translate", "yes");
    document.querySelector("#command")?.setAttribute("translate", "no");
    expect(extractSegments(document, state)).toEqual([]);

    const paragraph = document.querySelector<HTMLElement>("#paragraph");
    if (paragraph === null) {
      throw new Error("Source check fixture was not created.");
    }
    // A restored run stays readable inside a protected block.
    paragraph.setAttribute("translate", "no");
    expect(getCurrentSourceText(paragraph, state)).toBe("Paralume");
    document.querySelector("#name")?.removeAttribute("translate");
    expect(getCurrentSourceText(paragraph, state)).toBe("");
    expect(extractSegments(document, state)).toEqual([]);
    expect(state.sourceMarkers.has(paragraph)).toBe(false);
    expect(paragraph.nextElementSibling?.tagName).toBe("UL");
    expect(document.body.textContent).not.toContain(
      "Translated Paragraph the page protects later",
    );

    paragraph.setAttribute("translate", "yes");
    expect(
      extractSegments(document, state).map(({ segment }) => segment.text),
    ).toEqual(["Paragraph the page protects later Paralume today"]);
  });
});
