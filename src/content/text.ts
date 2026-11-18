import {
  CANDIDATE_BLOCK_SELECTOR,
  MIN_MEANINGFUL_CHARACTERS,
} from "./constants";
import type { ContentRuntimeState } from "./state";

/**
 * Subtrees whose text never belongs to a readable segment, even when they sit
 * inside an otherwise eligible block. Mirrors the eligibility exclusions so a
 * paragraph cannot leak script/style source, form or button labels, or
 * navigation/footer copy into a translation request.
 */
const EXCLUDED_TEXT_SELECTOR = [
  "script",
  "style",
  "noscript",
  "template",
  "form",
  "button",
  "input",
  "textarea",
  "select",
  "option",
  "nav",
  "footer",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
].join(", ");

const STRUCTURAL_TAGS: ReadonlySet<string> = new Set(["LI", "TD", "TH"]);
const COMPOUND_TRIGGER_TAGS: ReadonlySet<string> = new Set([
  "LI",
  "TD",
  "TH",
  "PRE",
]);

const BLOCK_BOUNDARY_TAGS: ReadonlySet<string> = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const NO_BREAK_SPACE = String.fromCharCode(0xa0);
const LINE_BREAK_MARKER_START = String.fromCharCode(0xe000);
const LINE_BREAK_MARKER_EXTENSION = String.fromCharCode(0xe001);
const READABLE_WHITESPACE = new RegExp(`[\\s${NO_BREAK_SPACE}]+`, "gu");
const PREFORMATTED_HORIZONTAL_SPACE = new RegExp(
  `[\\t\\f\\v${NO_BREAK_SPACE} ]+`,
  "gu",
);

export function normalizeReadableText(text: string): string {
  return text.replace(READABLE_WHITESPACE, " ").trim();
}

function explicitLineBreakMarker(text: string): string {
  let marker = LINE_BREAK_MARKER_START;
  while (text.includes(marker)) {
    marker += LINE_BREAK_MARKER_EXTENSION;
  }
  return marker;
}

function normalizePreformattedText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(PREFORMATTED_HORIZONTAL_SPACE, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function isInsideOwnedNode(
  element: Element,
  boundary: Element,
  state: ContentRuntimeState | undefined,
): boolean {
  if (state === undefined) {
    return false;
  }
  for (
    let current: Element | null = element;
    current !== null && current !== boundary;
    current = current.parentElement
  ) {
    if (state.ownedNodes.has(current)) {
      return true;
    }
  }
  return false;
}

function nestedCandidates(
  container: HTMLElement,
  state: ContentRuntimeState | undefined,
): Element[] {
  return Array.from(
    container.querySelectorAll(CANDIDATE_BLOCK_SELECTOR),
  ).filter((nested) => !isInsideOwnedNode(nested, container, state));
}

/**
 * The candidate blocks nested in `container` that are not themselves nested
 * in another candidate below `container` (Paralume-owned nodes are ignored).
 */
function topLevelNestedCandidates(
  container: HTMLElement,
  state: ContentRuntimeState | undefined,
): Element[] {
  return nestedCandidates(container, state).filter((nested) => {
    for (
      let ancestor = nested.parentElement;
      ancestor !== null && ancestor !== container;
      ancestor = ancestor.parentElement
    ) {
      if (ancestor.matches(CANDIDATE_BLOCK_SELECTOR)) {
        return false;
      }
    }
    return true;
  });
}

/**
 * A nested candidate is "significant" when its whole visible subtree has
 * enough meaningful text to be translated somewhere below the container.
 * Only significant nested blocks are split out of their container; shorter
 * ones (for example a lone "Done." paragraph or a "$5" cell part) stay part
 * of the container's text so they are never silently dropped.
 */
function isSignificantNestedCandidate(
  nested: Element,
  state: ContentRuntimeState | undefined,
): boolean {
  return (
    nested instanceof HTMLElement &&
    hasMeaningfulText(readText(nested, state, false))
  );
}

/**
 * A list item or table cell is "compound" when it wraps a nested list/table,
 * a preformatted block, or more than one readable block. Compound containers
 * are not translated as one merged segment: their nested blocks become their
 * own segments, and the container contributes only its loose text. Nested
 * blocks without meaningful text of their own do not make it compound.
 *
 * The decision depends only on the visible DOM (not on eligibility state),
 * so it stays identical between extraction and later source-change checks.
 */
export function isCompoundStructuralContainer(
  element: HTMLElement,
  state?: ContentRuntimeState,
): boolean {
  if (!STRUCTURAL_TAGS.has(element.tagName)) {
    return false;
  }
  if (
    nestedCandidates(element, state).some(
      (candidate) =>
        COMPOUND_TRIGGER_TAGS.has(candidate.tagName) &&
        isSignificantNestedCandidate(candidate, state),
    )
  ) {
    return true;
  }
  return (
    topLevelNestedCandidates(element, state).filter((candidate) =>
      isSignificantNestedCandidate(candidate, state),
    ).length > 1
  );
}

/**
 * The nested blocks that are translated on their own and therefore excluded
 * from `element`'s text. A merged (non-compound) list item or table cell owns
 * all of its nested blocks, and a preformatted block is always one unit.
 * Every other candidate keeps only its loose text, so text directly inside a
 * container is neither dropped nor translated twice with a nested block.
 */
function splitOutCandidates(
  element: HTMLElement,
  state: ContentRuntimeState | undefined,
): Set<Element> {
  if (
    element.tagName === "PRE" ||
    (STRUCTURAL_TAGS.has(element.tagName) &&
      !isCompoundStructuralContainer(element, state))
  ) {
    return new Set();
  }
  return new Set(
    topLevelNestedCandidates(element, state).filter((candidate) =>
      isSignificantNestedCandidate(candidate, state),
    ),
  );
}

function isEditableElement(element: Element): boolean {
  const contentEditable = element.getAttribute("contenteditable");
  return contentEditable !== null && contentEditable.toLowerCase() !== "false";
}

interface TextCollectionContext {
  readonly parts: string[];
  readonly lineBreak: string;
  readonly view: (Window & typeof globalThis) | null;
  readonly state: ContentRuntimeState | undefined;
  readonly skippedSubtrees: ReadonlySet<Element>;
}

function isVisibilityHidden(style: CSSStyleDeclaration | undefined): boolean {
  return style?.visibility === "hidden" || style?.visibility === "collapse";
}

// Boxes that size containment cannot apply to; `content-visibility` has no
// effect on them (CSS Containment), so their contents still render.
const NO_CONTENT_VISIBILITY_DISPLAYS: ReadonlySet<string> = new Set([
  "inline",
  "contents",
  "table-row",
  "table-row-group",
  "table-header-group",
  "table-footer-group",
  "table-column",
  "table-column-group",
  "ruby-base",
  "ruby-text",
  "ruby-base-container",
  "ruby-text-container",
]);

/**
 * `content-visibility: hidden` keeps the element's own box but never renders
 * its contents (they stay out of find-in-page and the accessibility tree),
 * so none of the text inside such an element is readable. `auto` is not
 * hidden: it only defers rendering of off-screen content.
 */
export function isContentVisibilityHidden(
  style: CSSStyleDeclaration | undefined,
): boolean {
  if (style?.getPropertyValue("content-visibility").trim() !== "hidden") {
    return false;
  }
  return !NO_CONTENT_VISIBILITY_DISPLAYS.has(style.display);
}

function resolveVisibility(
  style: CSSStyleDeclaration | undefined,
  inherited: boolean,
): boolean {
  // `visibility` inherits but a descendant may override it with `visible`.
  if (style === undefined || style.visibility === "") {
    return inherited;
  }
  return !isVisibilityHidden(style);
}

function isBlockBoundary(
  element: Element,
  style: CSSStyleDeclaration | undefined,
): boolean {
  if (BLOCK_BOUNDARY_TAGS.has(element.tagName)) {
    return true;
  }
  const display = style?.display ?? "";
  return (
    display !== "" &&
    display !== "contents" &&
    display !== "none" &&
    !display.startsWith("inline")
  );
}

function shouldSkipElement(
  element: Element,
  style: CSSStyleDeclaration | undefined,
  context: TextCollectionContext,
): boolean {
  return (
    context.skippedSubtrees.has(element) ||
    (context.state?.ownedNodes.has(element) ?? false) ||
    element.matches(EXCLUDED_TEXT_SELECTOR) ||
    // `hidden` is `boolean | "until-found"`; both true and "until-found"
    // collapse the content, so only an explicit `false` counts as visible.
    (element instanceof HTMLElement && element.hidden !== false) ||
    element.getAttribute("aria-hidden") === "true" ||
    isEditableElement(element) ||
    style?.display === "none" ||
    isContentVisibilityHidden(style)
  );
}

function collectText(
  parent: Node,
  parentVisible: boolean,
  context: TextCollectionContext,
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child instanceof Text) {
      if (parentVisible) {
        context.parts.push(child.data);
      }
      continue;
    }
    if (!(child instanceof Element)) {
      continue;
    }

    const style = context.view?.getComputedStyle(child);
    if (shouldSkipElement(child, style, context)) {
      continue;
    }
    if (child.tagName === "BR") {
      if (parentVisible) {
        context.parts.push(context.lineBreak);
      }
      continue;
    }

    const boundary = isBlockBoundary(child, style);
    if (boundary) {
      context.parts.push(" ");
    }
    collectText(child, resolveVisibility(style, parentVisible), context);
    if (boundary) {
      context.parts.push(" ");
    }
  }
}

/**
 * Reads the text a reader would see in `element` by walking the live DOM. It
 * never clones the source or reads `innerText` from detached nodes (which
 * falls back to textContent and would include hidden, script, and other
 * excluded descendants), and it separates adjacent block children.
 *
 * When `state` is provided, Paralume-owned nodes (translations, retry
 * controls) are skipped. Nested readable blocks that are translated on their
 * own (see `splitOutCandidates`) are excluded, so compound list items/table
 * cells and other containers contribute only their loose text.
 */
export function getReadableText(
  element: HTMLElement,
  state?: ContentRuntimeState,
): string {
  return readText(element, state, true);
}

function readText(
  element: HTMLElement,
  state: ContentRuntimeState | undefined,
  excludeSplitOut: boolean,
): string {
  const view = element.ownerDocument.defaultView;
  const rootStyle = view?.getComputedStyle(element);
  if (isContentVisibilityHidden(rootStyle)) {
    return "";
  }
  const preformatted = element.tagName === "PRE";
  const lineBreak = preformatted
    ? "\n"
    : explicitLineBreakMarker(element.textContent);
  const context: TextCollectionContext = {
    parts: [],
    lineBreak,
    view,
    state,
    skippedSubtrees: excludeSplitOut
      ? splitOutCandidates(element, state)
      : new Set<Element>(),
  };
  collectText(element, resolveVisibility(rootStyle, true), context);
  const raw = context.parts.join("");

  if (preformatted) {
    return normalizePreformattedText(raw);
  }
  return normalizeReadableText(raw).replaceAll(lineBreak, "\n");
}

export function getCurrentSourceText(
  element: HTMLElement,
  state: ContentRuntimeState,
): string {
  return getReadableText(element, state);
}

export function hasMeaningfulText(text: string): boolean {
  return (
    (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= MIN_MEANINGFUL_CHARACTERS
  );
}
