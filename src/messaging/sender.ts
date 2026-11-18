// Runtime message sender checks. Chromium fills `sender` in the browser
// process, so a content script cannot choose its own `id` or `url`.

function readSenderString(
  sender: unknown,
  key: "id" | "url",
): string | undefined {
  if (typeof sender !== "object" || sender === null || !(key in sender)) {
    return undefined;
  }
  const value = (sender as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function getSenderUrl(sender: unknown): string | undefined {
  return readSenderString(sender, "url");
}

// True only for this extension's own pages (Options, Popup). Content scripts
// share the extension id but report the web page URL, so they never match.
export function createExtensionPageSenderCheck(
  extensionId: string,
  extensionBaseUrl: string,
): (sender: unknown) => boolean {
  const base = extensionBaseUrl.endsWith("/")
    ? extensionBaseUrl
    : `${extensionBaseUrl}/`;
  return (sender) => {
    const url = getSenderUrl(sender);
    return (
      extensionId.length > 0 &&
      readSenderString(sender, "id") === extensionId &&
      url?.startsWith(base) === true
    );
  };
}
