import { MIN_MEANINGFUL_CHARACTERS } from "./constants";
import type { ContentRuntimeState } from "./state";

export function normalizeReadableText(text: string): string {
  return text.replace(/[\s\u00a0]+/gu, " ").trim();
}

function explicitLineBreakMarker(text: string): string {
  let marker = "\uE000";
  while (text.includes(marker)) {
    marker += "\uE001";
  }
  return marker;
}

function normalizePreformattedText(text: string): string {
  return text
    .replace(/\r\n?/gu, "\n")
    .replace(/[\t\f\v\u00a0 ]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

export function getReadableText(element: HTMLElement): string {
  if (element.tagName === "PRE") {
    return normalizePreformattedText(element.innerText);
  }

  const clone = element.cloneNode(true) as HTMLElement;
  const marker = explicitLineBreakMarker(clone.innerText);
  for (const lineBreak of clone.querySelectorAll("br")) {
    lineBreak.replaceWith(marker);
  }
  return normalizeReadableText(clone.innerText).replaceAll(marker, "\n");
}

export function getCurrentSourceText(
  element: HTMLElement,
  state: ContentRuntimeState,
): string {
  const translation = state.translationsBySource.get(element);
  if (translation?.parentElement !== element) {
    return getReadableText(element);
  }

  const sourceChildren = Array.from(element.childNodes);
  const translationIndex = sourceChildren.indexOf(translation);
  const clone = element.cloneNode(true) as HTMLElement;
  clone.childNodes.item(translationIndex).remove();
  return getReadableText(clone);
}

export function hasMeaningfulText(text: string): boolean {
  return (
    (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= MIN_MEANINGFUL_CHARACTERS
  );
}
