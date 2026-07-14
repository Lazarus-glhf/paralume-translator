import { MIN_MEANINGFUL_CHARACTERS } from "./constants";
import type { ContentRuntimeState } from "./state";

export function normalizeReadableText(text: string): string {
  return text.replace(/[\s\u00a0]+/gu, " ").trim();
}

export function getReadableText(element: HTMLElement): string {
  return normalizeReadableText(element.innerText);
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
