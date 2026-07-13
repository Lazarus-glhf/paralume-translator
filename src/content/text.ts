import { MIN_MEANINGFUL_CHARACTERS } from "./constants";

export function normalizeReadableText(text: string): string {
  return text.replace(/[\s\u00a0]+/gu, " ").trim();
}

export function getReadableText(element: HTMLElement): string {
  return normalizeReadableText(element.innerText);
}

export function hasMeaningfulText(text: string): boolean {
  return (
    (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= MIN_MEANINGFUL_CHARACTERS
  );
}
