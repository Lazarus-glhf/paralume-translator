import { afterEach, describe, expect, it, vi } from "vitest";

import { clearTranslations } from "../src/content/cleanup";
import {
  PARALUME_OWNED_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
  PARALUME_TRANSLATION_FOR_ATTRIBUTE,
  PARALUME_TRANSLATION_STATUS_ATTRIBUTE,
} from "../src/content/constants";
import { extractSegments } from "../src/content/extractor";
import {
  getContentState,
  renderTranslation,
  setTranslationsVisible,
} from "../src/content/renderer";
import { createContentRuntimeState } from "../src/content/state";

afterEach(() => {
  document.body.replaceChildren();
});

describe("safe translation rendering", () => {
  it("interleaves one text-only translation while preserving source nodes and listeners", () => {
    document.body.innerHTML = `
      <article>
        <p id="source">Read the <a href="https://example.com/docs">complete documentation</a> first.</p>
      </article>
    `;
    const source = document.querySelector<HTMLElement>("#source");
    const link = document.querySelector<HTMLAnchorElement>("#source a");
    const listener = vi.fn();
    link?.addEventListener("click", listener);
    const originalInnerHtml = source?.innerHTML;
    const state = createContentRuntimeState({ runtimeId: "normal-render" });
    const extracted = extractSegments(document, state)[0];

    if (source === null || link === null || extracted === undefined) {
      throw new Error("Test fixture was not created.");
    }

    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "success",
        translatedText:
          '<img src=x onerror="globalThis.pwned=true">Translated text',
      },
      state,
    );

    expect(source.innerHTML).toBe(originalInnerHtml);
    expect(source.querySelector("a")).toBe(link);
    link.dispatchEvent(new MouseEvent("click"));
    expect(listener).toHaveBeenCalledOnce();
    expect(source.nextElementSibling).toBe(translation);
    expect(translation.textContent).toBe(
      '<img src=x onerror="globalThis.pwned=true">Translated text',
    );
    expect(translation.querySelector("img")).toBeNull();
    expect(translation.getAttribute(PARALUME_OWNED_ATTRIBUTE)).toBe("true");
    expect(translation.getAttribute(PARALUME_TRANSLATION_FOR_ATTRIBUTE)).toBe(
      extracted.segment.id,
    );
  });

  it("appends internal divs for list and table blocks without changing structure", () => {
    document.body.innerHTML = `
      <ul id="list"><li id="item">Readable <a href="#list-target">list item link</a></li></ul>
      <table><tbody><tr><th id="heading">Readable table heading</th><td id="cell">Readable <a href="#cell-target">table cell link</a></td></tr></tbody></table>
    `;
    const state = createContentRuntimeState({ runtimeId: "structural-render" });
    const [listItem, tableHeading, tableCell] = extractSegments(
      document,
      state,
    );
    const listLink = document.querySelector("#item a");
    const cellLink = document.querySelector("#cell a");
    const originalListChildCount =
      document.querySelectorAll("#list > li").length;
    const originalCellCount =
      document.querySelectorAll("tr > th, tr > td").length;

    if (
      listItem === undefined ||
      tableHeading === undefined ||
      tableCell === undefined
    ) {
      throw new Error("Test fixture was not extracted.");
    }

    const renderedList = renderTranslation(
      listItem,
      {
        id: listItem.segment.id,
        status: "success",
        translatedText: "Translated list item",
      },
      state,
    );
    const renderedHeading = renderTranslation(
      tableHeading,
      {
        id: tableHeading.segment.id,
        status: "success",
        translatedText: "Translated table heading",
      },
      state,
    );
    const renderedCell = renderTranslation(
      tableCell,
      {
        id: tableCell.segment.id,
        status: "success",
        translatedText: "Translated table cell",
      },
      state,
    );

    expect(
      [renderedList, renderedHeading, renderedCell].map(
        (element) => element.tagName,
      ),
    ).toEqual(["DIV", "DIV", "DIV"]);
    expect(listItem.element.lastElementChild).toBe(renderedList);
    expect(tableHeading.element.lastElementChild).toBe(renderedHeading);
    expect(tableCell.element.lastElementChild).toBe(renderedCell);
    expect(renderedList.parentElement).toBe(listItem.element);
    expect(renderedHeading.parentElement).toBe(tableHeading.element);
    expect(renderedCell.parentElement).toBe(tableCell.element);
    expect(document.querySelector("#item a")).toBe(listLink);
    expect(document.querySelector("#cell a")).toBe(cellLink);
    expect(document.querySelectorAll("#list > li")).toHaveLength(
      originalListChildCount,
    );
    expect(document.querySelectorAll("tr > th, tr > td")).toHaveLength(
      originalCellCount,
    );
  });

  it("reuses and updates an existing translation instead of duplicating it", () => {
    document.body.innerHTML = `<p>Readable source paragraph content</p>`;
    const state = createContentRuntimeState({ runtimeId: "reuse-render" });
    const extracted = extractSegments(document, state)[0];

    if (extracted === undefined) {
      throw new Error("Test fixture was not extracted.");
    }

    const first = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "success",
        translatedText: "First translation",
      },
      state,
    );
    const second = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "failure",
        error: {
          code: "TRANSLATION_FAILED",
          message: "Provider could not translate this block.",
          retryable: false,
        },
      },
      state,
    );

    expect(second).toBe(first);
    expect(second.textContent).toBe(
      "Translation unavailable. Provider could not translate this block.",
    );
    expect(second.getAttribute(PARALUME_TRANSLATION_STATUS_ATTRIBUTE)).toBe(
      "failure",
    );
    expect(
      document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toHaveLength(1);
  });
});

describe("translation visibility and cleanup", () => {
  it("hides and shows owned translation blocks idempotently", () => {
    document.body.innerHTML = `<p>Readable source paragraph content</p>`;
    const state = createContentRuntimeState({ runtimeId: "visibility" });
    const extracted = extractSegments(document, state)[0];

    if (extracted === undefined) {
      throw new Error("Test fixture was not extracted.");
    }

    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "success",
        translatedText: "Translated paragraph content",
      },
      state,
    );

    setTranslationsVisible(document, state, false);
    setTranslationsVisible(document, state, false);
    expect(translation.hidden).toBe(true);
    expect(translation.style.getPropertyValue("display")).toBe("none");
    expect(translation.style.getPropertyPriority("display")).toBe("important");
    expect(getContentState(document, state)).toEqual({
      translationCount: 1,
      failureCount: 0,
      visible: false,
    });

    setTranslationsVisible(document, state, true);
    setTranslationsVisible(document, state, true);
    expect(translation.hidden).toBe(false);
    expect(translation.style.getPropertyValue("display")).toBe("");
    expect(getContentState(document, state).visible).toBe(true);
  });

  it("removes only translation nodes and source markers and restores structure", () => {
    document.body.innerHTML = `
      <article>
        <p id="source">Readable source paragraph content</p>
        <aside id="host-node" class="paralume-translation">Host-owned lookalike</aside>
      </article>
    `;
    const source = document.querySelector<HTMLElement>("#source");
    const original = document.body.innerHTML;
    const state = createContentRuntimeState({ runtimeId: "cleanup" });
    const extracted = extractSegments(document, state)[0];

    if (source === null || extracted === undefined) {
      throw new Error("Test fixture was not extracted.");
    }

    renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "success",
        translatedText: "Translated paragraph content",
      },
      state,
    );
    expect(source.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(true);

    expect(clearTranslations(document, state)).toBe(1);
    expect(clearTranslations(document, state)).toBe(0);
    expect(document.querySelector("#host-node")).not.toBeNull();
    expect(source.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(false);
    expect(document.body.innerHTML).toBe(original);
  });

  it("never trusts or mutates host nodes with spoofed ownership attributes", () => {
    document.body.innerHTML = `
      <article>
        <p id="source" ${PARALUME_SOURCE_ID_ATTRIBUTE}="host-source-id">Readable host paragraph with a spoofed source marker</p>
        <div
          id="spoof-translation"
          ${PARALUME_OWNED_ATTRIBUTE}="true"
          ${PARALUME_TRANSLATION_FOR_ATTRIBUTE}="host-source-id"
          ${PARALUME_TRANSLATION_STATUS_ATTRIBUTE}="failure"
        >Host-owned spoofed translation node</div>
      </article>
    `;
    const source = document.querySelector<HTMLElement>("#source");
    const spoof = document.querySelector<HTMLElement>("#spoof-translation");
    const state = createContentRuntimeState({ runtimeId: "spoof-safety" });
    const extracted = extractSegments(document, state)[0];

    if (source === null || spoof === null || extracted === undefined) {
      throw new Error("Spoofed ownership fixture was not created.");
    }

    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "success",
        translatedText: "Actual runtime translation",
      },
      state,
    );

    expect(translation).not.toBe(spoof);
    expect(spoof.textContent).toBe("Host-owned spoofed translation node");
    expect(source.getAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(
      "host-source-id",
    );
    expect(clearTranslations(document, state)).toBe(1);
    expect(spoof.isConnected).toBe(true);
    expect(spoof.textContent).toBe("Host-owned spoofed translation node");
    expect(source.getAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(
      "host-source-id",
    );
  });
});
