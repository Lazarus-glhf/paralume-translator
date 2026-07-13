export type RuntimeMessageHandler<Response = unknown> = (
  message: unknown,
  context?: { readonly sender: unknown },
) => Promise<Response>;

function isSettingsTarget(message: unknown): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    "target" in message &&
    message.target === "settings"
  );
}

export function createBackgroundRouter<TranslationResponse, SettingsResponse>(
  translationHandler: RuntimeMessageHandler<TranslationResponse>,
  settingsHandler: RuntimeMessageHandler<SettingsResponse>,
): RuntimeMessageHandler<TranslationResponse | SettingsResponse> {
  return (message, context) =>
    isSettingsTarget(message)
      ? settingsHandler(message, context)
      : translationHandler(message, context);
}
