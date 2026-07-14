import { CANDIDATE_BLOCK_SELECTOR } from "./constants";
import type { ContentRuntimeState } from "./state";
import { getReadableText, hasMeaningfulText } from "./text";

const EXCLUDED_ANCESTOR_SELECTOR = [
  "script",
  "style",
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
].join(", ");

function isEditable(element: HTMLElement): boolean {
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    const contentEditable = current.getAttribute("contenteditable");
    if (contentEditable !== null && contentEditable.toLowerCase() !== "false") {
      return true;
    }
  }

  return false;
}

function isHidden(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;

  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true") {
      return true;
    }

    const style = view?.getComputedStyle(current);
    if (
      style?.display === "none" ||
      style?.visibility === "hidden" ||
      style?.visibility === "collapse"
    ) {
      return true;
    }
  }

  return false;
}

function isRuntimeOwned(
  element: HTMLElement,
  state: ContentRuntimeState,
): boolean {
  for (
    let current: HTMLElement | null = element;
    current !== null;
    current = current.parentElement
  ) {
    if (state.ownedNodes.has(current)) {
      return true;
    }
  }

  return false;
}

function hasProcessedStructuralAncestor(
  element: HTMLElement,
  state: ContentRuntimeState,
): boolean {
  for (
    let current = element.parentElement;
    current !== null;
    current = current.parentElement
  ) {
    if (
      ["LI", "TD", "TH"].includes(current.tagName) &&
      state.sourceMarkers.has(current)
    ) {
      return true;
    }
  }

  return false;
}

export function isEligibleCandidate(
  element: Element,
  state: ContentRuntimeState,
): element is HTMLElement {
  if (
    !(element instanceof HTMLElement) ||
    !element.matches(CANDIDATE_BLOCK_SELECTOR) ||
    state.sourceMarkers.has(element) ||
    hasProcessedStructuralAncestor(element, state) ||
    isRuntimeOwned(element, state) ||
    element.closest(EXCLUDED_ANCESTOR_SELECTOR) !== null ||
    (element.tagName !== "PRE" && element.closest("code, pre") !== null) ||
    isEditable(element) ||
    isHidden(element)
  ) {
    return false;
  }

  return hasMeaningfulText(getReadableText(element));
}
