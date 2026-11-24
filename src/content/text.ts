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

/** Semantic computer-code markup: source code, sample output, and input. */
export const CODE_ELEMENT_SELECTOR = "code, samp, kbd";
const CODE_TAGS: ReadonlySet<string> = new Set(["CODE", "SAMP", "KBD"]);

type TranslateState = "yes" | "no";

/**
 * The state set by an element's own `translate` attribute. Following the HTML
 * enumerated-attribute rules, "" and "yes" mean yes and "no" means no (ASCII
 * case-insensitive, no trimming); a missing or invalid value is `null`, so
 * the element inherits its parent's state.
 */
function ownTranslateState(element: Element): TranslateState | null {
  const value = element.getAttribute("translate");
  if (value === null) {
    return null;
  }
  // Without the `u` flag, `i` never folds non-ASCII characters to ASCII.
  if (/^(?:yes)?$/i.test(value)) {
    return "yes";
  }
  return /^no$/i.test(value) ? "no" : null;
}

/**
 * Whether the page allows `element` to be translated: the nearest element
 * (itself included) with a valid `translate` value decides, and the document
 * default is yes. Mirrors `HTMLElement.translate` without relying on it.
 */
export function isTranslationEnabled(element: Element): boolean {
  for (
    let current: Element | null = element;
    current !== null;
    current = current.parentElement
  ) {
    const state = ownTranslateState(current);
    if (state !== null) {
      return state === "yes";
    }
  }
  return true;
}

/** Whether `node` holds letters outside code, sample, or input markup. */
function hasProseOutsideCode(node: Node): boolean {
  for (const child of Array.from(node.childNodes)) {
    if (child instanceof Text) {
      if (/\p{L}/u.test(child.data)) {
        return true;
      }
    } else if (
      child instanceof Element &&
      !CODE_TAGS.has(child.tagName) &&
      hasProseOutsideCode(child)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * A standalone block of code: a `pre` whose text is all code, sample output,
 * or input markup (`pre > code`, as documentation sites and highlighters such
 * as Shiki emit), or a code element rendered as a block. Such blocks are never
 * translated, even without `translate="no"`. A `pre` without code markup, or
 * with prose around inline code (`Press <kbd>Enter</kbd> to continue`), is
 * preformatted prose and stays translatable.
 */
export function isCodeBlockElement(
  element: Element,
  style?: CSSStyleDeclaration,
): boolean {
  if (element.tagName === "PRE") {
    return (
      element.querySelector(CODE_ELEMENT_SELECTOR) !== null &&
      !hasProseOutsideCode(element)
    );
  }
  if (!CODE_TAGS.has(element.tagName)) {
    return false;
  }
  const resolved =
    style ?? element.ownerDocument.defaultView?.getComputedStyle(element);
  return isBlockBoundary(element, resolved);
}

/** Whether `element` sits inside code markup or a standalone code block. */
function isWithinCode(element: Element): boolean {
  for (
    let current = element.parentElement;
    current !== null;
    current = current.parentElement
  ) {
    if (
      CODE_TAGS.has(current.tagName) ||
      (current.tagName === "PRE" && isCodeBlockElement(current))
    ) {
      return true;
    }
  }
  return false;
}

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
 * a preformatted prose block, or more than one readable block. Compound
 * containers are not translated as one merged segment: their nested blocks
 * become their own segments, and the container contributes only its loose
 * text. Nested blocks without meaningful readable text of their own (code
 * blocks and `translate="no"` blocks included) do not make it compound.
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
  /** Collected text nodes with letters outside inline code/`translate="no"`. */
  proseTextNodes: number;
  /** Collected text nodes with letters or numbers inside inline code/no. */
  protectedTextNodes: number;
}

/** The inherited state of the subtree being collected. */
interface TextScope {
  /** Rendered (resolved `visibility`). */
  readonly visible: boolean;
  /** Translatable according to the nearest valid `translate` attribute. */
  readonly translatable: boolean;
  /** Inside inline code markup. */
  readonly inCode: boolean;
  /** Inside an inline `translate="no"` run within translatable text. */
  readonly inNoTranslateRun: boolean;
}

const LETTER = /\p{L}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function childScope(
  child: Element,
  boundary: boolean,
  style: CSSStyleDeclaration | undefined,
  scope: TextScope,
): TextScope {
  const translate = ownTranslateState(child);
  let translatable = scope.translatable;
  let inNoTranslateRun = scope.inNoTranslateRun;
  if (translate === "yes") {
    translatable = true;
    inNoTranslateRun = false;
  } else if (translate === "no") {
    if (boundary) {
      translatable = false;
    } else {
      // An inline `translate="no"` run (a product name, an identifier) stays
      // in its sentence as context, like inline code, but cannot make a
      // block translatable on its own.
      inNoTranslateRun = true;
    }
  }
  return {
    visible: resolveVisibility(style, scope.visible),
    translatable,
    inCode: scope.inCode || CODE_TAGS.has(child.tagName),
    inNoTranslateRun,
  };
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
  scope: TextScope,
  context: TextCollectionContext,
): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child instanceof Text) {
      if (scope.visible && scope.translatable) {
        context.parts.push(child.data);
        if (scope.inCode || scope.inNoTranslateRun) {
          if (LETTER_OR_NUMBER.test(child.data)) {
            context.protectedTextNodes += 1;
          }
        } else if (LETTER.test(child.data)) {
          context.proseTextNodes += 1;
        }
      }
      continue;
    }
    if (!(child instanceof Element)) {
      continue;
    }

    const style = context.view?.getComputedStyle(child);
    if (shouldSkipElement(child, style, context)) {
      // Hidden, extension-owned, or otherwise unrendered nodes leave no gap:
      // `micro<div hidden>…</div>scope` still reads as one word.
      continue;
    }
    if (isCodeBlockElement(child, style)) {
      // A rendered code block is a block on its own (a `pre`, or code shown
      // as a block), so its line break survives its removal and the text
      // around it never runs together.
      context.parts.push(" ");
      continue;
    }
    if (child.tagName === "BR") {
      if (scope.visible && scope.translatable) {
        context.parts.push(context.lineBreak);
      }
      continue;
    }

    const boundary = isBlockBoundary(child, style);
    const partCount = context.parts.length;
    const proseTextNodes = context.proseTextNodes;
    const protectedTextNodes = context.protectedTextNodes;
    if (boundary) {
      context.parts.push(" ");
    }
    collectText(child, childScope(child, boundary, style, scope), context);
    if (boundary) {
      if (
        context.proseTextNodes === proseTextNodes &&
        context.protectedTextNodes > protectedTextNodes
      ) {
        // A nested block holding only inline code or `translate="no"` text
        // (for example a short command in its own paragraph or div) is not
        // prose, so it is never merged into its list item or table cell.
        context.parts.length = partCount;
        context.protectedTextNodes = protectedTextNodes;
      }
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
 *
 * Code blocks and blocks with an effective `translate="no"` are excluded too,
 * and so is any nested block that holds only inline code or inline
 * `translate="no"` text. Inline code and inline `translate="no"` runs inside
 * prose stay in the sentence as context.
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
  if (
    isContentVisibilityHidden(rootStyle) ||
    isCodeBlockElement(element, rootStyle) ||
    isWithinCode(element)
  ) {
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
    proseTextNodes: 0,
    protectedTextNodes: 0,
  };
  // The block's own `translate` state is inherited from its ancestors, so
  // extraction and every later source check (stale results, changed
  // sources) apply the same rule; `translate="yes"` descendants restore it.
  collectText(
    element,
    {
      visible: resolveVisibility(rootStyle, true),
      translatable: isTranslationEnabled(element),
      inCode: false,
      inNoTranslateRun: false,
    },
    context,
  );
  if (context.proseTextNodes === 0 && context.protectedTextNodes > 0) {
    // Only inline code or `translate="no"` text (a lone command, an
    // identifier cell): there is no prose to translate.
    return "";
  }
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
