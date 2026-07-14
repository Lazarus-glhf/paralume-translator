import { afterEach, describe, expect, it, vi } from "vitest";

import { clearTranslations } from "../src/content/cleanup";
import {
  PARALUME_OWNED_ATTRIBUTE,
  PARALUME_SOURCE_ID_ATTRIBUTE,
  PARALUME_RETRY_ATTRIBUTE,
  PARALUME_TRANSLATION_FOR_ATTRIBUTE,
  PARALUME_TRANSLATION_STATUS_ATTRIBUTE,
} from "../src/content/constants";
import { extractSegments } from "../src/content/extractor";
import {
  applyAppearanceToTranslations,
  getContentState,
  renderTranslation,
  setTranslationPending,
  setTranslationsVisible,
} from "../src/content/renderer";
import { createContentRuntimeState } from "../src/content/state";
import { DEFAULT_APPEARANCE_SETTINGS } from "../src/settings/repository";
import { createError } from "../src/shared/errors";

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
    expect(translation.style.padding).toBe("0.2em 0px 0.35em");
    expect(translation.style.borderInlineStart).toBe("0 solid transparent");
    expect(translation.style.transition).toContain("opacity");
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
      true,
      { locale: "en", onRetry: vi.fn() },
    );

    expect(second).toBe(first);
    expect(second.textContent).toContain("Translation unavailable.");
    expect(second.textContent).toContain("Retry");
    expect(second.getAttribute(PARALUME_TRANSLATION_STATUS_ATTRIBUTE)).toBe(
      "failure",
    );
    expect(
      document.querySelectorAll(`[${PARALUME_TRANSLATION_FOR_ATTRIBUTE}]`),
    ).toHaveLength(1);
  });

  it("renders an accessible localized text-only retry control and pending state", () => {
    document.body.innerHTML = `<p id="source">Readable retry source paragraph</p>`;
    const state = createContentRuntimeState({ runtimeId: "retry-render" });
    const extracted = extractSegments(document, state)[0];
    const onRetry = vi.fn();
    if (extracted === undefined) {
      throw new Error("Retry fixture was not extracted.");
    }

    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "failure",
        error: createError("AUTHENTICATION_FAILED"),
      },
      state,
      true,
      { locale: "zh-CN", onRetry },
    );
    const button = translation.querySelector<HTMLButtonElement>(
      `[${PARALUME_RETRY_ATTRIBUTE}]`,
    );

    expect(translation.textContent).toContain(
      "译文不可用。翻译服务拒绝了已配置的凭据。",
    );
    expect(translation.querySelector("img, script, style")).toBeNull();
    expect(button).not.toBeNull();
    expect(button?.type).toBe("button");
    expect(button?.textContent).toBe("重试");
    expect(button?.getAttribute("aria-label")).toBe("重试此可读文本块的翻译");
    expect(button?.getAttribute(PARALUME_OWNED_ATTRIBUTE)).toBe("true");
    expect(button?.style.justifySelf).toBe("end");

    button?.click();
    expect(onRetry).toHaveBeenCalledOnce();
    setTranslationPending(translation, state, true, "zh-CN");
    expect(button?.disabled).toBe(true);
    expect(button?.textContent).toBe("正在重试…");
    button?.click();
    expect(onRetry).toHaveBeenCalledOnce();
    setTranslationPending(translation, state, false, "zh-CN");
    expect(button?.disabled).toBe(false);
    expect(button?.textContent).toBe("重试");
  });

  it("renders a localized failure without Retry when no segment retry action is provided", () => {
    document.body.innerHTML = `<p>Readable request-global failure source</p>`;
    const state = createContentRuntimeState({ runtimeId: "global-render" });
    const extracted = extractSegments(document, state)[0];
    if (extracted === undefined) {
      throw new Error("Global failure fixture was not extracted.");
    }

    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "failure",
        error: createError("AUTHENTICATION_FAILED"),
      },
      state,
      true,
      { locale: "en" },
    );

    expect(translation.textContent).toContain(
      "The provider rejected the configured credentials.",
    );
    expect(
      translation.querySelector(`[${PARALUME_RETRY_ATTRIBUTE}]`),
    ).toBeNull();
  });

  it("follows each source block's typography while preserving safe appearance overrides", () => {
    document.body.innerHTML = `
      <article>
        <h2 id="heading" style="font-family: Georgia; font-size: 34px; font-weight: 700; line-height: 1.2; letter-spacing: 2px; text-align: center; text-transform: uppercase; color: rgb(42, 51, 66); background-color: rgb(240, 242, 248); opacity: 0.9">Readable source heading</h2>
        <p id="body" style="font-family: Arial; font-size: 15px; font-weight: 400; line-height: 1.75; text-align: start">Readable body paragraph content.</p>
        <pre id="code" style="font-family: monospace; font-size: 13px; line-height: 1.45; tab-size: 4"><code>const readableGuidance = true;</code></pre>
      </article>
    `;
    const state = createContentRuntimeState({ runtimeId: "source-typography" });
    const extracted = extractSegments(document, state);
    const translations = extracted.map((item) =>
      renderTranslation(
        item,
        {
          id: item.segment.id,
          status: "success",
          translatedText: `译文 ${item.segment.text}`,
        },
        state,
      ),
    );

    expect(translations).toHaveLength(3);
    expect(translations[0]?.style.fontFamily).toContain("Georgia");
    expect(translations[0]?.style.fontSize).toBe("34px");
    expect(translations[0]?.style.fontWeight).toBe("700");
    expect(translations[0]?.style.lineHeight).toBe("1.2");
    expect(translations[0]?.style.letterSpacing).toBe("2px");
    expect(translations[0]?.style.textAlign).toBe("center");
    expect(translations[0]?.style.textTransform).toBe("uppercase");
    expect(translations[0]?.style.color).toBe("rgb(42, 51, 66)");
    expect(translations[0]?.style.backgroundColor).toBe("rgb(240, 242, 248)");
    expect(translations[0]?.style.opacity).toBe("0.9");
    expect(translations[1]?.style.fontFamily).toContain("Arial");
    expect(translations[1]?.style.fontSize).toBe("15px");
    expect(translations[1]?.style.lineHeight).toBe("1.75");
    expect(translations[2]?.style.fontFamily).toContain("monospace");
    expect(translations[2]?.style.whiteSpace).toBe("pre-wrap");

    applyAppearanceToTranslations(document, state, {
      ...DEFAULT_APPEARANCE_SETTINGS,
      fontFamily: "serif",
      fontSize: 21,
      lineHeight: 2,
    });
    expect(translations[0]?.style.fontFamily).toContain("serif");
    expect(translations[0]?.style.fontSize).toBe("21px");
    expect(translations[0]?.style.lineHeight).toBe("2");
    expect(translations[0]?.style.fontWeight).toBe("700");
    expect(translations[1]?.style.textAlign).toBe("start");
  });

  it("applies validated appearance only to owned existing/future UI", () => {
    document.body.innerHTML = `<p id="source" style="color: rgb(1, 2, 3); margin: 19px">Readable appearance source paragraph</p>`;
    const source = document.querySelector<HTMLElement>("#source");
    const state = createContentRuntimeState({ runtimeId: "appearance-render" });
    const extracted = extractSegments(document, state)[0];
    if (source === null || extracted === undefined) {
      throw new Error("Appearance fixture was not extracted.");
    }
    const originalSourceStyle = source.getAttribute("style");
    const first = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "success",
        translatedText: "Existing translation",
      },
      state,
      true,
      { locale: "en", appearance: DEFAULT_APPEARANCE_SETTINGS },
    );
    const custom = {
      fontFamily: "serif" as const,
      fontSize: 21,
      textColor: "#112233",
      backgroundColor: "#ddeeff",
      lineHeight: 2,
      opacity: 0.7,
      verticalSpacing: 17,
    };

    applyAppearanceToTranslations(document, state, custom);

    expect(first.style.fontFamily).toContain("serif");
    expect(first.style.fontSize).toBe("21px");
    expect(first.style.color).toBe("#112233");
    expect(first.style.backgroundColor).toBe("#ddeeff");
    expect(first.style.lineHeight).toBe("2");
    expect(first.style.opacity).toBe("0.7");
    expect(first.style.marginBlock).toBe("17px");
    expect(source.getAttribute("style")).toBe(originalSourceStyle);

    const secondSource = document.createElement("p");
    secondSource.textContent = "Readable future appearance paragraph";
    document.body.append(secondSource);
    const future = extractSegments(document, state)[0];
    if (future === undefined) {
      throw new Error("Future appearance fixture was not extracted.");
    }
    const second = renderTranslation(
      future,
      {
        id: future.segment.id,
        status: "success",
        translatedText: "Future translation",
      },
      state,
      true,
      { locale: "en", appearance: custom },
    );
    expect(second.style.fontSize).toBe("21px");
    expect(secondSource.getAttribute("style")).toBeNull();
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

  it("cleans up retry listeners and excludes owned retry UI from extraction", () => {
    document.body.innerHTML = `<p>Readable cleanup retry paragraph</p>`;
    const state = createContentRuntimeState({ runtimeId: "retry-cleanup" });
    const extracted = extractSegments(document, state)[0];
    const onRetry = vi.fn();
    if (extracted === undefined) {
      throw new Error("Retry cleanup fixture was not extracted.");
    }
    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "failure",
        error: createError("NETWORK_ERROR"),
      },
      state,
      true,
      { locale: "en", onRetry },
    );
    const button = translation.querySelector<HTMLButtonElement>("button");
    if (button === null) {
      throw new Error("Retry button was not rendered.");
    }

    expect(extractSegments(document, state)).toHaveLength(0);
    expect(clearTranslations(document, state)).toBe(1);
    button.click();
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("releases detached translations, markers, and retry listeners on Clear", () => {
    document.body.innerHTML = `<p id="source">Readable detached cleanup paragraph</p>`;
    const state = createContentRuntimeState({ runtimeId: "detached-cleanup" });
    const extracted = extractSegments(document, state)[0];
    const onRetry = vi.fn();
    if (extracted === undefined) {
      throw new Error("Detached cleanup fixture was not extracted.");
    }
    const translation = renderTranslation(
      extracted,
      {
        id: extracted.segment.id,
        status: "failure",
        error: createError("NETWORK_ERROR"),
      },
      state,
      true,
      { locale: "en", onRetry },
    );
    const button = translation.querySelector<HTMLButtonElement>("button");
    if (button === null) {
      throw new Error("Detached retry control was not created.");
    }
    extracted.element.remove();

    expect(clearTranslations(document, state)).toBe(1);
    expect(state.translations.size).toBe(0);
    expect(state.sourceMarkers.size).toBe(0);
    expect(state.retryControls.size).toBe(0);
    expect(extracted.element.hasAttribute(PARALUME_SOURCE_ID_ATTRIBUTE)).toBe(
      false,
    );
    button.click();
    expect(onRetry).not.toHaveBeenCalled();
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
