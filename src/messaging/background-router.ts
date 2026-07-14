export type RuntimeMessageHandler<Response = unknown, Sender = unknown> = (
  message: unknown,
  context?: { readonly sender: Sender },
) => Promise<Response>;

function isSettingsTarget(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "target" in message &&
    message.target === "settings"
  );
}

export function createBackgroundRouter<
  TranslationResponse,
  SettingsResponse,
  Sender = unknown,
>(
  translationHandler: RuntimeMessageHandler<TranslationResponse, Sender>,
  settingsHandler: RuntimeMessageHandler<SettingsResponse, Sender>,
): RuntimeMessageHandler<TranslationResponse | SettingsResponse, Sender> {
  return (message, context) =>
    isSettingsTarget(message)
      ? settingsHandler(message, context)
      : translationHandler(message, context);
}
